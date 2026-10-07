import {
  isActiveJobStatus,
  TRANSCRIPTION_EVENTS_RETRY_MS,
  TRANSCRIPTION_SECONDS_MAX,
  type TranscriptionAnalyze,
  type TranscriptionDispatch,
  type TranscriptionJob,
  type TranscriptionJobCreate,
  type TranscriptionJobCreated,
  type TranscriptionResult,
  type TranscriptionSpeakerColorId,
  type TranscriptionTranscript,
  type TranscriptionTranscriptCreate,
  type TranscriptionTranscriptPatch,
  type TranscriptionUploadTarget
} from '@justcampus/shared'
import { ApiRequestError } from '@/lib/api'
import { UploadError } from '../api'
import type { TranscriptionEvents } from '../events'
import {
  voiceDispatch,
  voicesFromSpeakers,
  type NumberedLabel,
  type VoiceDraft
} from '../mapping/speakers'
import type { UploadSettings } from '../workspace'
import { transcriptCreate, type FileResult } from './merge'
import { creepStep, CREEP_MS, PROGRESS, transcriptionDisplay, uploadProgress } from './progress'
import {
  addToGroup,
  allFiles,
  analysisPending,
  creatingJob,
  defaultGroupName,
  dropTargetIndex,
  EMPTY_QUEUE,
  findFile,
  findFileByJob,
  moveFile as moveQueueFile,
  newGroup,
  noticeOf,
  queueFileFrom,
  removeFile as removeQueueFile,
  removeGroup as removeQueueGroup,
  renumberGroups,
  restoredGroupName,
  updateFile,
  updateGroup,
  type FileError,
  type FilePosition,
  type QueueFile,
  type QueueGroup,
  type QueueState,
  type SaveConflict
} from './queue'

/** The endpoints the queue uses; `api.ts`'s functions, or stand-ins in tests. */
export interface UploadApi {
  listJobs: (signal?: AbortSignal) => Promise<TranscriptionJob[]>
  createJob: (input: TranscriptionJobCreate) => Promise<TranscriptionJobCreated>
  getJob: (id: string, signal?: AbortSignal) => Promise<TranscriptionJob>
  analyzeJob: (id: string, input?: TranscriptionAnalyze) => Promise<TranscriptionJob>
  dispatchJob: (id: string, input: TranscriptionDispatch) => Promise<TranscriptionJob>
  deleteJob: (id: string) => Promise<void>
  createTranscript: (input: TranscriptionTranscriptCreate) => Promise<TranscriptionTranscript>
  getTranscript: (id: string, signal?: AbortSignal) => Promise<TranscriptionTranscript>
  patchTranscript: (
    id: string,
    patch: TranscriptionTranscriptPatch
  ) => Promise<TranscriptionTranscript>
}

export type SignedUpload = (
  target: TranscriptionUploadTarget,
  body: Blob,
  options: { onProgress?: (fraction: number) => void; signal?: AbortSignal }
) => Promise<void>

export interface UploadQueueOptions {
  api: UploadApi
  upload: SignedUpload
  /** The page's event stream, which tells how each job goes on (T-11, T-15). */
  events: TranscriptionEvents
  /** The upload settings (T-09); `configure` keeps them current, and dispatch reads them anew. */
  settings: UploadSettings
  /** Files one group (one transcript) may hold, as the capabilities say; `null`: no limit. */
  maxFilesPerGroup?: number | null
  /** The automatic labels in the UI language: `Stimme 1`, `Beispiel 1`. */
  labels: QueueLabels
  /** The local file's length in seconds, `null` when the browser cannot tell. */
  measureDuration: (file: File) => Promise<number | null>
  /** A job was created or deleted, e.g. for the dashboard's count of active jobs. */
  onJobsChanged?: () => void
  /** A transcript was saved or renamed; the caller updates its caches. */
  onTranscriptSaved?: (transcript: TranscriptionTranscript) => void
  /** A group was saved as a new transcript (not renamed), e.g. to wait for its AI title (T-23). */
  onTranscriptCreated?: (transcript: TranscriptionTranscript) => void
  /**
   * A save refused (`409`) because another page of the user saved the group's jobs first: the
   * transcript that holds them now stands for this save, e.g. for the local history (T-39).
   */
  onSaveAdopted?: (
    input: TranscriptionTranscriptCreate,
    transcript: TranscriptionTranscript
  ) => void
  /** The newest revision of a transcript the page knows, for renaming it (T-14). */
  latestRevision?: (transcriptId: string) => number | null
  /** Wait before a failed fetch of a job is tried again. */
  syncRetryMs?: number
  creepMs?: number
}

export interface QueueLabels {
  autoLabel: NumberedLabel
  sampleLabel: NumberedLabel
}

/** What a start did: the transcripts it saved, and whether anything failed. */
export interface StartOutcome {
  status: 'done' | 'empty' | 'busy'
  savedIds: string[]
  failed: boolean
}

/** Following a job gives up after this many failed fetches in a row (the network, not the job). */
const MAX_SYNC_ERRORS = 5

/**
 * Uploads of this browser session that may outlive the page that started them, by job id: leaving
 * the page lets them finish and start the analysis, so the job is restored later (T-15). The
 * promise tells whether the analysis was started.
 */
const runningUploads = new Map<string, Promise<boolean>>()

class Aborted extends Error {
  constructor() {
    super('aborted')
    this.name = 'Aborted'
  }
}

/** A job could not be followed: removed on the server, or fetching it failed too often. */
class JobLost extends Error {
  constructor(readonly reason: unknown) {
    super('job lost')
    this.name = 'JobLost'
  }
}

/** The server's own words for a failure, when it gave any. */
function messageOf(error: unknown): string | null {
  if (error instanceof ApiRequestError) return error.body?.error.message ?? null
  if (error instanceof Error && !(error instanceof UploadError)) return error.message
  return null
}

/** A storage failure as kiChat names it (T-16). */
function uploadError(error: unknown): FileError {
  if (error instanceof UploadError) {
    if (error.kind === 'status') return { key: 's3UploadFailed', status: error.status }
    if (error.kind === 'aborted') return { key: 'uploadAborted' }
  }
  return { key: 's3UploadNetworkError' }
}

const isGone = (error: unknown): boolean =>
  error instanceof ApiRequestError && (error.status === 404 || error.status === 410)

/** The server's words for a job that could not be followed; none for a removed one. */
const lostMessage = (error: unknown): string | null =>
  messageOf(error instanceof JobLost ? error.reason : error)

/** A duration the server accepts as a hint. */
function durationHint(duration: number | null): number | null {
  return duration !== null && Number.isFinite(duration) && duration >= 0
    ? Math.min(duration, TRANSCRIPTION_SECONDS_MAX)
    : null
}

/**
 * The upload queue and everything it does on its own, after kiChat's `TranscriptUI`: each file
 * added is uploaded and analysed at once (T-10), restored jobs are picked up (T-15), the start
 * transcribes the groups one after the other and the files of a group side by side (T-13), and a
 * group whose files all succeeded is joined and saved as one transcript (T-14). It is an external
 * store for `useSyncExternalStore`; the work runs on even while nothing renders it.
 */
export class UploadQueue {
  private state: QueueState = EMPTY_QUEUE
  private readonly listeners = new Set<() => void>()
  /** What follows each file's job, at most one at a time. */
  private readonly flows = new Map<string, AbortController>()
  /** Running uploads by file, aborted only when the file is removed. */
  private readonly uploads = new Map<string, AbortController>()
  private readonly creeps = new Map<string, ReturnType<typeof setInterval>>()
  private readonly reanalyzing = new Set<string>()
  /**
   * Files whose job is being deleted, with whether that worked; their group is not saved meanwhile,
   * and a flow that loses the job then waits for the outcome (`keptAfterRemoval`).
   */
  private readonly removals = new Map<string, Promise<boolean>>()
  /**
   * Groups whose transcript is being saved, with the save's outcome. Neither they nor their files
   * are removed or moved meanwhile: deleting a job deletes its audio, a saved one's too.
   */
  private readonly saving = new Map<string, Promise<string | null>>()
  private lifetime = new AbortController()
  /**
   * The restore under way; leaving the upload view or `dispose` aborts it, so nothing it listed
   * comes back after that.
   */
  private restore: AbortController | null = null
  /** The restore the last report of the upload view started; settled once its jobs are back. */
  private restoration: Promise<void> = Promise.resolve()
  /** The page's view as last reported by `showView`. */
  private view: string | null = null
  private options: UploadQueueOptions

  constructor(options: UploadQueueOptions) {
    this.options = options
  }

  /** Takes the current upload settings, UI language and file limit per group. */
  configure(change: {
    settings?: UploadSettings
    labels?: QueueLabels
    maxFilesPerGroup?: number | null
  }): void {
    this.options = { ...this.options, ...change }
  }

  // -------------------------------------------------------------------------
  // Store
  // -------------------------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): QueueState => this.state

  private set(next: QueueState): void {
    if (next === this.state) return
    this.state = next
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  private setGroups(change: (groups: QueueGroup[]) => QueueGroup[]): void {
    this.set({ ...this.state, groups: change(this.state.groups) })
  }

  private patchFile(
    fileId: string,
    change: Partial<QueueFile> | ((file: QueueFile) => Partial<QueueFile>)
  ): void {
    if (!findFile(this.state.groups, fileId)) return
    this.setGroups((groups) => updateFile(groups, fileId, change))
  }

  private file(fileId: string): QueueFile | null {
    return findFile(this.state.groups, fileId)?.file ?? null
  }

  private group(groupId: string): QueueGroup | null {
    return this.state.groups.find((group) => group.id === groupId) ?? null
  }

  /** Resolves once `ready` holds, or once `signal` aborts (by default: the queue is disposed). */
  private waitFor(ready: () => boolean, signal = this.lifetime.signal): Promise<void> {
    return new Promise((resolve) => {
      if (ready() || signal.aborted) {
        resolve()
        return
      }
      const done = (): void => {
        unsubscribe()
        signal.removeEventListener('abort', done)
        resolve()
      }
      const unsubscribe = this.subscribe(() => {
        if (ready()) done()
      })
      signal.addEventListener('abort', done, { once: true })
    })
  }

  /**
   * Takes over the queue's work again after `dispose`. The active jobs are restored only when the
   * upload view opens (`showView`), as kiChat restores them in its file view.
   */
  attach(): void {
    if (this.lifetime.signal.aborted) this.lifetime = new AbortController()
  }

  /**
   * Stops following the jobs when the page goes. Uploads finish and start their analysis, so their
   * jobs are restored when the page comes back.
   */
  dispose(): void {
    this.lifetime.abort()
    this.cancelRestore()
    for (const controller of this.flows.values()) controller.abort()
    this.flows.clear()
    for (const timer of this.creeps.values()) clearInterval(timer)
    this.creeps.clear()
  }

  private get disposed(): boolean {
    return this.lifetime.signal.aborted
  }

  /** A new following of a file's job, ending the one before. */
  private startFlow(fileId: string): AbortController {
    this.flows.get(fileId)?.abort()
    const controller = new AbortController()
    this.flows.set(fileId, controller)
    return controller
  }

  private endFlow(fileId: string, controller: AbortController): void {
    if (this.flows.get(fileId) === controller) this.flows.delete(fileId)
    this.stopCreep(fileId)
  }

  private startCreep(fileId: string, to: number): void {
    if (this.creeps.has(fileId)) return
    const timer = setInterval(() => {
      this.patchFile(fileId, (file) => ({ progress: creepStep(file.progress, to) }))
    }, this.options.creepMs ?? CREEP_MS)
    this.creeps.set(fileId, timer)
  }

  private stopCreep(fileId: string): void {
    const timer = this.creeps.get(fileId)
    if (timer === undefined) return
    clearInterval(timer)
    this.creeps.delete(fileId)
  }

  private fail(fileId: string, phase: 'analysisFailed' | 'failed', error: FileError): void {
    this.stopCreep(fileId)
    this.patchFile(fileId, {
      phase,
      progress: 100,
      status: 'failed',
      tone: 'error',
      error,
      notice: null
    })
  }

  // -------------------------------------------------------------------------
  // Adding files (T-03 to T-06, T-10)
  // -------------------------------------------------------------------------

  /**
   * Adds checked files to a group (`null`: where dropped files go) and uploads them. Files already
   * in that group are skipped before the limit counts (T-05). Nothing is added while a start runs,
   * nor to a group being saved. Returns the rows added.
   */
  addFiles(files: readonly File[], groupIndex: number | null = null): QueueFile[] {
    if (this.state.processing || files.length === 0) return []
    let groups = this.state.groups
    const index = groupIndex ?? dropTargetIndex(groups)
    const target = groups[index]
    if (target && (target.saved || this.saving.has(target.id))) return []
    const room = this.room(groups[index]?.files.length ?? 0)
    const result = addToGroup(groups, index, files.map(queueFileFrom), room)
    groups = renumberGroups(result.groups)
    this.set({ ...this.state, groups })
    for (const row of result.added) this.track(row)
    return result.added
  }

  /**
   * Adds files as a group of their own, e.g. the recorded takes (T-58): into the first empty group
   * or a new one, named `name` if given.
   */
  addGroupOfFiles(files: readonly File[], name: string | null): QueueFile[] {
    if (this.state.processing || files.length === 0) return []
    let groups = [...this.state.groups]
    let index = groups.findIndex((group) => group.saved === null && group.files.length === 0)
    if (index < 0) {
      index = groups.length
      groups.push(newGroup(index, name ?? defaultGroupName(index)))
    } else if (name) groups[index] = { ...groups[index]!, name }
    const result = addToGroup(groups, index, files.map(queueFileFrom), this.room(0))
    groups = renumberGroups(result.groups)
    this.set({ ...this.state, groups })
    for (const row of result.added) this.track(row)
    return result.added
  }

  /** How many more files a group of `present` files takes (T-04: the admin's limit, if set). */
  private room(present: number): number {
    const limit = this.options.maxFilesPerGroup
    return limit === null || limit === undefined ? Infinity : Math.max(0, limit - present)
  }

  /** Measures a new row's length and starts its upload. */
  private track(row: QueueFile): void {
    const local = row.file
    if (local) {
      void this.options.measureDuration(local).then((duration) => {
        if (duration !== null) {
          this.patchFile(row.id, (file) => (file.duration === null ? { duration } : {}))
        }
      })
    }
    void this.autoAnalyze(row.id)
  }

  /** The duration the player found, if none is known yet. */
  setDuration(fileId: string, duration: number): void {
    if (!Number.isFinite(duration) || duration <= 0) return
    const file = this.file(fileId)
    if (file && file.duration === null) this.patchFile(fileId, { duration })
  }

  /**
   * kiChat's `autoAnalyzeFile`: creates the job, uploads the bytes with progress, then asks for the
   * speaker analysis and waits for it (T-10). Failures stay on the row (T-16).
   */
  private async autoAnalyze(fileId: string): Promise<void> {
    const position = findFile(this.state.groups, fileId)
    const local = position?.file.file
    if (!position || !local || position.file.phase !== 'idle') return
    const settings = this.options.settings
    this.patchFile(fileId, {
      phase: 'uploading',
      progress: PROGRESS.session,
      status: 'creatingSession',
      tone: 'processing',
      error: null
    })

    let created: TranscriptionJobCreated
    try {
      created = await this.options.api.createJob({
        filename: local.name,
        size: local.size,
        mimeType: local.type,
        language: settings.language,
        speakerCount: settings.speakerCount,
        llmCorrection: settings.llmCorrection,
        groupId: position.group.id,
        groupOrder: position.fileIndex
      })
    } catch (error) {
      this.fail(fileId, 'analysisFailed', {
        key: 'uploadSessionFailed',
        message: messageOf(error)
      })
      return
    }
    const jobId = created.job.id
    this.options.onJobsChanged?.()
    if (!this.file(fileId)) {
      // Removed while the job was made: it goes too.
      void this.options.api.deleteJob(jobId).catch(() => undefined)
      return
    }
    this.patchFile(fileId, { jobId, jobStatus: created.job.status })

    const controller = new AbortController()
    this.uploads.set(fileId, controller)
    let uploadFailure: FileError | null = null
    let analyzeFailure: string | null | undefined
    const running = (async (): Promise<boolean> => {
      try {
        await this.options.upload(created.upload, local, {
          signal: controller.signal,
          onProgress: (fraction) =>
            this.patchFile(fileId, { progress: uploadProgress(fraction), status: 'uploadingFile' })
        })
      } catch (error) {
        uploadFailure = uploadError(error)
        return false
      } finally {
        this.uploads.delete(fileId)
      }
      // Only now, with storage's answer, may the analysis start (kiChat).
      this.patchFile(fileId, {
        uploaded: true,
        progress: PROGRESS.uploadEnd,
        status: 'analyzingAudio'
      })
      try {
        const job = await this.options.api.analyzeJob(jobId, {
          duration: durationHint(this.file(fileId)?.duration ?? null),
          speakerCount: this.options.settings.speakerCount
        })
        this.patchFile(fileId, { jobStatus: job.status })
        return true
      } catch (error) {
        analyzeFailure = messageOf(error) ?? ''
        return false
      }
    })()
    runningUploads.set(jobId, running)
    const analysing = await running
    runningUploads.delete(jobId)
    if (this.disposed || !this.file(fileId)) return
    if (!analysing) {
      this.fail(
        fileId,
        'analysisFailed',
        uploadFailure ?? { key: 'analysisJobStartFailed', message: analyzeFailure || null }
      )
      return
    }
    await this.followAnalysis(fileId, jobId, { keepVoices: false })
  }

  /**
   * The job as the event stream reports it, one state at a time, until the flow is aborted
   * (`Aborted`) or the job is lost (`JobLost`). It is fetched once after each (re)connect of the
   * stream, and once right away when the stream is up already, as events may have been missed
   * meanwhile; a `completed` job is fetched for its result, which events leave out. A fetch answers
   * for the states reported before it; one the stream reported on the job while it ran may be older
   * than those reports and is dropped, as they follow. A failed fetch is tried again on the next
   * (re)connect, or after `syncRetryMs` at the latest, so a passing failure does not leave the file
   * waiting; after `MAX_SYNC_ERRORS` failures in a row, or once the job is gone, it is lost.
   */
  private async *jobStates(jobId: string, signal: AbortSignal): AsyncGenerator<TranscriptionJob> {
    type Item = { kind: 'job'; job: TranscriptionJob } | { kind: 'sync' } | { kind: 'gone' }
    const inbox: Item[] = []
    let wake: (() => void) | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    // The stream's reports on the job, counted to tell a fetch they overtook.
    let reports = 0
    const push = (item: Item): void => {
      inbox.push(item)
      wake?.()
    }
    const onAbort = (): void => wake?.()
    signal.addEventListener('abort', onAbort, { once: true })
    const unsubscribe = this.options.events.subscribe({
      onOpen: () => push({ kind: 'sync' }),
      onEvent: (event) => {
        if (event.type === 'job' && event.data.id === jobId) {
          reports++
          push(
            event.data.status === 'completed' ? { kind: 'sync' } : { kind: 'job', job: event.data }
          )
        } else if (event.type === 'jobRemoved' && event.data.id === jobId) {
          reports++
          push({ kind: 'gone' })
        }
      }
    })
    let errors = 0
    try {
      for (;;) {
        if (signal.aborted) throw new Aborted()
        const item = inbox.shift()
        if (!item) {
          await new Promise<void>((resolve) => {
            wake = resolve
          })
          wake = null
          continue
        }
        if (item.kind === 'gone') throw new JobLost(null)
        if (item.kind === 'job') {
          yield item.job
          continue
        }
        // One fetch answers every sync asked for and every state reported so far.
        for (let index = inbox.length - 1; index >= 0; index--) {
          if (inbox[index]!.kind !== 'gone') inbox.splice(index, 1)
        }
        if (retryTimer) clearTimeout(retryTimer)
        retryTimer = null
        const reportsBefore = reports
        let job: TranscriptionJob
        try {
          job = await this.options.api.getJob(jobId, signal)
          errors = 0
        } catch (error) {
          if (signal.aborted) throw new Aborted()
          if (isGone(error) || ++errors >= MAX_SYNC_ERRORS) throw new JobLost(error)
          retryTimer = setTimeout(
            () => push({ kind: 'sync' }),
            this.options.syncRetryMs ?? TRANSCRIPTION_EVENTS_RETRY_MS
          )
          continue
        }
        if (signal.aborted) throw new Aborted()
        // Reported on meanwhile: the answer may predate those reports, which are in the inbox (a
        // `completed` one as a sync, so its result is still fetched).
        if (reports !== reportsBefore) continue
        yield job
      }
    } finally {
      unsubscribe()
      signal.removeEventListener('abort', onAbort)
      if (retryTimer) clearTimeout(retryTimer)
    }
  }

  /**
   * Follows a job until its analysis ends (T-10, T-21): the bar waits at 50 % while queued and
   * creeps towards 98 % while analysing. Resolves whether the voices arrived.
   */
  private async followAnalysis(
    fileId: string,
    jobId: string,
    { keepVoices, onPoll }: { keepVoices: boolean; onPoll?: () => void }
  ): Promise<boolean> {
    // Removed meanwhile, e.g. during a start: nothing to follow.
    if (!this.file(fileId)) return false
    const controller = this.startFlow(fileId)
    const signal = controller.signal
    this.patchFile(fileId, { phase: 'analyzing', tone: 'processing', error: null, notice: null })
    try {
      for await (const job of this.jobStates(jobId, signal)) {
        this.patchFile(fileId, { jobStatus: job.status })
        if (job.status === 'failed' || job.status === 'cancelled') {
          this.fail(fileId, 'analysisFailed', {
            key: 'analysisError',
            message: job.error?.message ?? null
          })
          return false
        }
        if (job.status === 'analyzed') {
          this.stopCreep(fileId)
          this.patchFile(fileId, (file) => ({
            phase: 'ready',
            progress: PROGRESS.done,
            status: 'readyForTranscription',
            tone: 'ready',
            error: null,
            notice: noticeOf(job),
            uploaded: true,
            duration: file.duration ?? job.duration,
            voices: voicesFromSpeakers(
              job.speakers,
              this.options.labels,
              keepVoices ? file.voices : null
            ),
            voicesSaved: keepVoices ? file.voicesSaved : false
          }))
          return true
        }
        onPoll?.()
        if (job.status === 'analyzing') {
          this.patchFile(fileId, (file) => ({
            status: 'analyzingSpeakers',
            progress: Math.max(file.progress, PROGRESS.uploadEnd)
          }))
          this.startCreep(fileId, PROGRESS.analysisCreepTo)
        } else if (job.status === 'analyzingQueued') {
          this.stopCreep(fileId)
          this.patchFile(fileId, { status: 'waitingForAnalysis', progress: PROGRESS.uploadEnd })
        }
      }
      return false
    } catch (error) {
      if (error instanceof Aborted || signal.aborted) return false
      if (!(await this.keptAfterRemoval(fileId)) || signal.aborted) return false
      this.fail(fileId, 'analysisFailed', {
        key: 'analysisError',
        message: lostMessage(error)
      })
      return false
    } finally {
      this.endFlow(fileId, controller)
    }
  }

  /**
   * Runs the speaker analysis again (T-21), from the mapping dialog or before a transcription is
   * retried. `keepVoices` keeps the names, colours and samples of voices found again and the voices
   * added by hand (T-20). `onPoll` hears every state of the job that says the analysis still runs
   * (the dialog's button then says so, as kiChat's after each poll). Resolves once the voices are
   * there, or with the server's reason when it failed.
   */
  async reanalyze(
    fileId: string,
    { keepVoices, onPoll }: { keepVoices: boolean; onPoll?: () => void }
  ): Promise<{ ok: true } | { ok: false; message: string | null }> {
    const file = this.file(fileId)
    if (!file?.jobId || !file.uploaded || this.reanalyzing.has(fileId)) {
      return { ok: false, message: null }
    }
    this.reanalyzing.add(fileId)
    try {
      try {
        const job = await this.options.api.analyzeJob(file.jobId, {
          duration: durationHint(file.duration),
          speakerCount: this.options.settings.speakerCount
        })
        this.patchFile(fileId, {
          jobStatus: job.status,
          phase: 'analyzing',
          progress: PROGRESS.uploadEnd,
          status: 'waitingForAnalysis',
          tone: 'processing',
          error: null,
          result: null
        })
      } catch (error) {
        return { ok: false, message: messageOf(error) }
      }
      const ok = await this.followAnalysis(fileId, file.jobId, { keepVoices, onPoll })
      if (ok) return { ok: true }
      return { ok: false, message: this.file(fileId)?.error?.message ?? null }
    } finally {
      this.reanalyzing.delete(fileId)
    }
  }

  /** Whether the analysis of a file is being repeated. */
  isReanalyzing(fileId: string): boolean {
    return this.reanalyzing.has(fileId)
  }

  /**
   * Tries a failed row again (T-16): a file whose upload did not finish is uploaded anew, as a new
   * job; an uploaded one is analysed again.
   */
  async retry(fileId: string): Promise<void> {
    const file = this.file(fileId)
    if (!file || file.phase !== 'analysisFailed' || this.state.processing) return
    if (file.uploaded && file.jobId) {
      await this.reanalyze(fileId, { keepVoices: true })
      return
    }
    if (!file.file) return
    if (file.jobId) void this.options.api.deleteJob(file.jobId).catch(() => undefined)
    this.patchFile(fileId, {
      jobId: null,
      jobStatus: null,
      phase: 'idle',
      progress: 0,
      status: 'ready',
      tone: 'ready',
      error: null
    })
    await this.autoAnalyze(fileId)
  }

  // -------------------------------------------------------------------------
  // Restoring active jobs (T-15)
  // -------------------------------------------------------------------------

  /**
   * kiChat's `loadActiveJobs`, run each time the upload view opens: the user's unsaved jobs come
   * back, each as a group of its own named after its file, without a local file. Jobs the queue
   * already has are skipped; a restore already under way is not started twice. One aborted by
   * leaving the upload view or by `dispose` restores nothing; the next visit lists again.
   */
  async restoreActiveJobs(): Promise<void> {
    if (this.restore || this.disposed) return
    const restore = new AbortController()
    this.restore = restore
    const { signal } = restore
    try {
      let jobs: TranscriptionJob[]
      try {
        jobs = await this.options.api.listJobs(signal)
      } catch {
        // Like kiChat, a failed listing only means nothing is restored; the next visit tries again.
        return
      }
      if (signal.aborted) return
      // A row whose job is being created may be listed before it knows its job id: once it does,
      // the check below skips that job.
      await this.waitFor(() => !allFiles(this.state.groups).some(creatingJob), signal)
      for (const job of jobs) {
        if (signal.aborted) return
        if (job.transcriptId !== null || job.status === 'cancelled') continue
        if (findFileByJob(this.state.groups, job.id)) continue
        this.restoreJob(job)
      }
    } finally {
      if (this.restore === restore) this.restore = null
    }
  }

  /** Ends the restore under way, if any. */
  private cancelRestore(): void {
    this.restore?.abort()
    this.restore = null
  }

  private restoreJob(job: TranscriptionJob): void {
    const row: QueueFile = {
      id: crypto.randomUUID(),
      name: job.filename,
      size: job.size,
      lastModified: null,
      mimeType: job.mimeType,
      file: null,
      restored: true,
      duration: job.duration,
      jobId: job.id,
      jobStatus: job.status,
      uploaded: job.status !== 'uploading',
      phase: 'ready',
      progress: PROGRESS.done,
      status: 'readyForTranscription',
      tone: 'ready',
      error: null,
      notice: noticeOf(job),
      // An analysed job without voices still opens the dialog, to add them (kiChat's
      // `hydrateRestoredSpeakers`); one not analysed yet has none to show.
      voices:
        job.status === 'analyzed' || job.speakers.length > 0
          ? voicesFromSpeakers(job.speakers, this.options.labels)
          : null,
      voicesSaved: false,
      result: null
    }
    const groups = [...this.state.groups]
    let index = groups.findIndex((group) => group.saved === null && group.files.length === 0)
    if (index < 0) {
      index = groups.length
      groups.push(newGroup(index))
    }
    const group = groups[index]!
    const name = /^Transcript \d+$/.test(group.name) ? restoredGroupName(job.filename) : group.name
    groups[index] = { ...group, name, files: [row] }
    this.set({ ...this.state, groups })

    switch (job.status) {
      case 'uploading': {
        const running = runningUploads.get(job.id)
        if (!running) {
          this.fail(row.id, 'analysisFailed', { key: 'uploadAborted' })
          return
        }
        this.patchFile(row.id, {
          phase: 'uploading',
          progress: PROGRESS.uploadEnd,
          status: 'uploadingFile',
          tone: 'processing'
        })
        void running.then((analysing) => {
          if (this.disposed) return
          if (analysing) {
            this.patchFile(row.id, { uploaded: true })
            void this.followAnalysis(row.id, job.id, { keepVoices: false })
          } else this.fail(row.id, 'analysisFailed', { key: 'uploadAborted' })
        })
        return
      }
      case 'analyzingQueued':
      case 'analyzing':
        this.patchFile(row.id, {
          phase: 'analyzing',
          progress: PROGRESS.uploadEnd,
          status: 'analyzingSpeakers',
          tone: 'processing'
        })
        void this.followAnalysis(row.id, job.id, { keepVoices: false })
        return
      case 'analyzed':
        return
      case 'failed':
        // With voices the analysis worked and the transcription failed.
        this.fail(row.id, job.speakers.length > 0 ? 'failed' : 'analysisFailed', {
          key: job.speakers.length > 0 ? 'transcriptionError' : 'analysisError',
          message: job.error?.message ?? null
        })
        return
      default:
        this.patchFile(row.id, {
          phase: 'transcribing',
          progress: PROGRESS.restored,
          status: 'inProgress',
          tone: 'processing'
        })
        void this.resumeTranscription(row.id, job.id)
    }
  }

  /**
   * kiChat's `resumeTranscriptionPolling`: waits for a restored transcription and saves it once
   * its group is complete.
   */
  private async resumeTranscription(fileId: string, jobId: string): Promise<void> {
    const result = await this.followTranscription(fileId, jobId)
    if (!result || this.disposed || this.state.processing) return
    const position = findFile(this.state.groups, fileId)
    if (!position || position.group.saved) return
    if (position.group.files.every((file) => file.result !== null)) {
      await this.saveGroup(position.group.id)
    }
  }

  // -------------------------------------------------------------------------
  // Transcription (T-11, T-13, T-14)
  // -------------------------------------------------------------------------

  /**
   * kiChat's `startTranscription`: the groups one after the other, the files of a group side by
   * side. A file is dispatched once; one that succeeded before keeps its result. A group is saved
   * only when all its files succeeded.
   */
  async start(): Promise<StartOutcome> {
    if (this.state.processing) return { status: 'busy', savedIds: [], failed: false }
    if (!this.state.groups.some((group) => group.files.length > 0)) {
      return { status: 'empty', savedIds: [], failed: false }
    }
    this.set({ ...this.state, processing: true })
    const savedIds: string[] = []
    let failed = false
    try {
      for (const groupId of this.state.groups.map((group) => group.id)) {
        if (this.disposed) break
        const group = this.group(groupId)
        if (!group || group.saved || group.files.length === 0) continue
        const results = await Promise.all(group.files.map((file) => this.processFile(file.id)))
        if (this.disposed) break
        // A file removed meanwhile (kiChat lets the user cancel it) leaves the group unsaved; the
        // next start reuses the results of the files that stayed.
        const now = this.group(groupId)
        const intact = group.files.every((file) => now?.files.some(({ id }) => id === file.id))
        if (intact && results.every((result) => result !== null)) {
          const id = await this.saveGroup(groupId, { afterStart: true })
          if (id) savedIds.push(id)
          else failed = true
        } else failed = true
      }
    } finally {
      this.set({ ...this.state, processing: false })
    }
    return { status: 'done', savedIds, failed }
  }

  /** One file of a started group: its result, or `null` when it failed. */
  private async processFile(fileId: string): Promise<TranscriptionResult | null> {
    let file = this.file(fileId)
    if (!file) return null
    if (file.result) {
      this.patchFile(fileId, {
        phase: 'completed',
        progress: PROGRESS.done,
        status: 'readyFromCache',
        tone: 'success',
        error: null
      })
      return file.result
    }

    // A restored transcription already runs on the server: no second dispatch, wait for it.
    if (file.phase === 'transcribing' && this.flows.has(fileId)) {
      this.patchFile(fileId, { status: 'inProgress', tone: 'processing' })
      await this.waitFor(() => {
        const current = this.file(fileId)
        return !current || current.phase !== 'transcribing' || !this.flows.has(fileId)
      })
      file = this.file(fileId)
      if (!file || this.disposed) return null
      if (file.result) return file.result
      if (file.phase !== 'failed') this.fail(fileId, 'failed', { key: 'fileProcessingFailed' })
      return null
    }

    if (analysisPending(file)) {
      this.patchFile(fileId, {
        progress: PROGRESS.uploadEnd,
        status: 'waitingForAnalysis',
        tone: 'processing'
      })
      await this.waitFor(() => {
        const current = this.file(fileId)
        return !current || !analysisPending(current)
      })
      file = this.file(fileId)
      if (!file || this.disposed) return null
    }

    if (file.phase === 'analysisFailed' || !file.jobId) {
      // The reason the analysis failed stays; kiChat only said the file could not be processed.
      this.fail(fileId, 'analysisFailed', file.error ?? { key: 'fileProcessingFailed' })
      return null
    }
    const jobId = file.jobId

    if (file.jobStatus === 'failed') {
      // A failed transcription is dispatched again with the voices as they are (kiChat reuses
      // the file's mapping and samples). Only when the server refuses that, because the analysis
      // itself failed, is it analysed again first, keeping names, samples and added voices.
      const outcome = file.phase === 'failed' ? await this.dispatch(fileId, jobId, file) : 'refused'
      if (outcome === 'failed') return null
      if (outcome === 'refused') {
        const again = await this.reanalyze(fileId, { keepVoices: true })
        if (!again.ok) {
          // A refused analysis request leaves the row as the dispatch left it: say it failed.
          if (this.file(fileId)?.phase === 'transcribing') {
            this.fail(fileId, 'failed', { key: 'processingJobStartFailed', message: again.message })
          }
          return null
        }
        file = this.file(fileId)
        if (!file || this.disposed) return null
        if ((await this.dispatch(fileId, jobId, file)) === 'failed') return null
      }
    } else if (file.jobStatus === null || file.jobStatus === 'analyzed') {
      // A 409 here means it was dispatched before (the answer got lost): follow that one.
      if ((await this.dispatch(fileId, jobId, file)) === 'failed') return null
    }
    return this.followTranscription(fileId, jobId)
  }

  /**
   * Sends a file's dispatch. `refused` is the server's `409`: dispatched already, or (for a failed
   * job) not dispatchable before another analysis. `failed` is on the row already.
   */
  private async dispatch(
    fileId: string,
    jobId: string,
    file: QueueFile
  ): Promise<'sent' | 'refused' | 'failed'> {
    this.patchFile(fileId, {
      phase: 'transcribing',
      progress: PROGRESS.dispatched,
      status: 'preprocessing',
      tone: 'processing',
      error: null
    })
    try {
      const job = await this.options.api.dispatchJob(jobId, this.dispatchInput(file))
      this.patchFile(fileId, { jobStatus: job.status })
      return 'sent'
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 409) return 'refused'
      this.fail(fileId, 'failed', { key: 'processingJobStartFailed', message: messageOf(error) })
      return 'failed'
    }
  }

  /** Names, windows and colours of the voices with the current settings (T-09, T-18). */
  private dispatchInput(file: QueueFile): TranscriptionDispatch {
    const settings = this.options.settings
    const voices = voiceDispatch(file.voices ?? [], file.duration, this.options.labels.autoLabel)
    return {
      mapping: voices.mapping,
      snippets: voices.snippets,
      colors: voices.colors,
      speakerCount: settings.speakerCount,
      llmCorrection: settings.llmCorrection,
      language: settings.language
    }
  }

  /**
   * Follows a dispatched job until it ends, showing its phase and chunks (T-11), also after a
   * reload. Resolves the result, or `null`.
   */
  private async followTranscription(
    fileId: string,
    jobId: string
  ): Promise<TranscriptionResult | null> {
    // Removed while it was dispatched (kiChat cancels the job then): nothing to follow.
    if (!this.file(fileId)) return null
    const controller = this.startFlow(fileId)
    const signal = controller.signal
    try {
      for await (const job of this.jobStates(jobId, signal)) {
        this.patchFile(fileId, { jobStatus: job.status })
        if (job.status === 'failed' || job.status === 'cancelled') {
          this.fail(fileId, 'failed', {
            key: 'transcriptionError',
            message: job.error?.message ?? null
          })
          return null
        }
        if (job.status === 'completed') {
          if (!job.result) {
            this.fail(fileId, 'failed', { key: 'noServerResponse' })
            return null
          }
          const result = job.result
          this.stopCreep(fileId)
          this.patchFile(fileId, (file) => ({
            phase: 'completed',
            result,
            duration: file.duration ?? job.duration ?? result.duration,
            progress: PROGRESS.done,
            status: 'transcriptionComplete',
            tone: 'success',
            error: null,
            notice: noticeOf(job)
          }))
          return result
        }
        const display = transcriptionDisplay(job)
        if (display) {
          if (display.creepTo !== undefined) {
            if (!this.creeps.has(fileId)) {
              this.patchFile(fileId, { progress: display.progress, status: display.status })
              this.startCreep(fileId, display.creepTo)
            }
          } else {
            this.stopCreep(fileId)
            this.patchFile(fileId, { progress: display.progress, status: display.status })
          }
        } else if (!isActiveJobStatus(job.status) && job.status !== 'analyzed') {
          // `uploading` cannot come back after a dispatch; treat it as lost.
          this.fail(fileId, 'failed', { key: 'fileProcessingFailed' })
          return null
        }
      }
      return null
    } catch (error) {
      if (error instanceof Aborted || signal.aborted) return null
      if (!(await this.keptAfterRemoval(fileId)) || signal.aborted) return null
      this.fail(fileId, 'failed', { key: 'transcriptionError', message: lostMessage(error) })
      return null
    } finally {
      this.endFlow(fileId, controller)
    }
  }

  /**
   * Joins a group's results and saves them as one transcript under the group's name (T-14). A
   * failed save keeps the results for another try with the same idempotency key. Saved by a start,
   * the rows keep their status ('Transcription abgeschlossen' or 'Bereit (aus Cache)'),
   * as kiChat's `saveProcessedFile` only adds the group's links; otherwise they read 'Fertig'.
   * A save of a group already being saved answers with that one.
   */
  async saveGroup(
    groupId: string,
    { afterStart = false }: { afterStart?: boolean } = {}
  ): Promise<string | null> {
    const running = this.saving.get(groupId)
    if (running) return running
    const group = this.group(groupId)
    if (!group || group.saved) return group?.saved?.id ?? null
    // A file on its way out is not saved with its group.
    if (group.files.some((file) => this.removals.has(file.id))) return null
    const files: FileResult[] = []
    const chosenColors = new Map<string, TranscriptionSpeakerColorId>()
    for (const file of group.files) {
      if (!file.result) return null
      files.push({ name: file.name, size: file.size, jobId: file.jobId, result: file.result })
      const voices = voiceDispatch(file.voices ?? [], file.duration, this.options.labels.autoLabel)
      for (const [id, name] of Object.entries(voices.mapping)) {
        const color = voices.colors[id]
        if (color && !chosenColors.has(name)) chosenColors.set(name, color)
      }
    }
    const index = this.state.groups.findIndex((candidate) => candidate.id === groupId)
    const title = group.name.trim() || defaultGroupName(Math.max(0, index))
    const input = transcriptCreate({
      idempotencyKey: group.idempotencyKey,
      title,
      files,
      chosenColors
    })
    // From the request until the group is saved or not, including the adoption after a `409`,
    // its files and the group stay (see `removeFile`).
    const saving = this.persistGroup(groupId, input, afterStart).finally(() => {
      this.saving.delete(groupId)
      this.notify()
    })
    this.saving.set(groupId, saving)
    this.notify()
    return saving
  }

  /** Whether a group's transcript is being saved; its files are neither removed nor moved then. */
  isSaving(groupId: string): boolean {
    return this.saving.has(groupId)
  }

  private async persistGroup(
    groupId: string,
    input: TranscriptionTranscriptCreate,
    afterStart: boolean
  ): Promise<string | null> {
    let transcript: TranscriptionTranscript
    try {
      transcript = await this.options.api.createTranscript(input)
    } catch (error) {
      const settled =
        error instanceof ApiRequestError && error.status === 409
          ? await this.savedElsewhere(input.jobIds)
          : null
      if (!settled || 'conflict' in settled) {
        this.setGroups((groups) =>
          updateGroup(groups, groupId, {
            saveFailed: !settled,
            saveConflict: settled?.conflict ?? null
          })
        )
        return null
      }
      transcript = settled.transcript
      this.options.onSaveAdopted?.(input, transcript)
    }
    this.options.onTranscriptSaved?.(transcript)
    this.options.onTranscriptCreated?.(transcript)
    this.setGroups((groups) =>
      groups.map((candidate) =>
        candidate.id === groupId
          ? {
              ...candidate,
              saveFailed: false,
              saveConflict: null,
              saved: { id: transcript.id, title: transcript.title, revision: transcript.revision },
              files: candidate.files.map((file) => ({
                ...file,
                phase: 'completed' as const,
                progress: PROGRESS.done,
                status: afterStart ? file.status : ('done' as const),
                tone: 'success' as const,
                error: null
              }))
            }
          : candidate
      )
    )
    return transcript.id
  }

  /**
   * After a save refused with `409`: another page of the user that restored the same jobs may
   * have saved them first (kiChat never stops a page from saving its own transcript). When all
   * jobs are in one transcript, that one is the group's. Jobs in different transcripts, or not all
   * completed, are a conflict another try cannot solve; `null` when the jobs could not be read or
   * show no reason, so the save may be tried again.
   */
  private async savedElsewhere(
    jobIds: readonly string[]
  ): Promise<{ transcript: TranscriptionTranscript } | { conflict: SaveConflict } | null> {
    try {
      const jobs = await Promise.all(jobIds.map((id) => this.options.api.getJob(id)))
      const transcriptIds = new Set(jobs.map((job) => job.transcriptId))
      const [only] = transcriptIds
      if (transcriptIds.size === 1 && only) {
        return { transcript: await this.options.api.getTranscript(only) }
      }
      if (jobs.some((job) => job.transcriptId !== null)) return { conflict: 'savedElsewhere' }
      if (jobs.some((job) => job.status !== 'completed')) return { conflict: 'notCompleted' }
      return null
    } catch {
      return null
    }
  }

  // -------------------------------------------------------------------------
  // Editing the queue (T-06 to T-08, T-18)
  // -------------------------------------------------------------------------

  /**
   * kiChat's `addGroup`: an empty group with the next default name, during a start too; the start
   * goes through the groups it had when it began, and the new one takes files once it ended.
   */
  addGroup(): void {
    this.setGroups((groups) => [...groups, newGroup(groups.length)])
  }

  /** Changes a group's name while it is typed. */
  renameGroup(groupId: string, name: string): void {
    this.setGroups((groups) => updateGroup(groups, groupId, { name }))
  }

  /**
   * The title the server gave a saved group's transcript afterwards (the AI title, T-23): its link
   * shows it, and the group's name follows unless the user is changing it, so leaving the name
   * field does not rename the transcript back.
   */
  takeGeneratedTitle(transcriptId: string, title: string): void {
    this.setGroups((groups) =>
      groups.map((group) => {
        const saved = group.saved
        if (saved?.id !== transcriptId || saved.title === title) return group
        const name = group.name.trim()
        return {
          ...group,
          name: !name || name === saved.title ? title : group.name,
          saved: { ...saved, title }
        }
      })
    )
  }

  /**
   * Settles a group's name when the field is left: empty becomes the default name. A saved group's
   * transcript is renamed too (kiChat's `syncGroupTranscriptionsTitle`). Resolves `false` when that
   * rename failed.
   */
  async commitGroupName(groupId: string): Promise<boolean> {
    const index = this.state.groups.findIndex((group) => group.id === groupId)
    const group = this.state.groups[index]
    if (!group) return true
    const name = group.name.trim() || defaultGroupName(index)
    if (name !== group.name) this.renameGroup(groupId, name)
    const saved = group.saved
    if (!saved || saved.title === name) return true
    try {
      const transcript = await this.renameTranscript(saved, name)
      this.options.onTranscriptSaved?.(transcript)
      this.setGroups((groups) =>
        updateGroup(groups, groupId, {
          saved: { id: transcript.id, title: transcript.title, revision: transcript.revision }
        })
      )
      return true
    } catch {
      return false
    }
  }

  private async renameTranscript(
    saved: { id: string; revision: number },
    title: string
  ): Promise<TranscriptionTranscript> {
    const baseRevision = this.options.latestRevision?.(saved.id) ?? saved.revision
    try {
      return await this.options.api.patchTranscript(saved.id, { baseRevision, title })
    } catch (error) {
      if (!(error instanceof ApiRequestError && error.status === 409)) throw error
      // Edited elsewhere since: rename the newest revision.
      const fresh = await this.options.api.getTranscript(saved.id)
      return this.options.api.patchTranscript(saved.id, { baseRevision: fresh.revision, title })
    }
  }

  /**
   * kiChat's `moveFile`: nothing moves while a start runs, into or out of a saved group or one
   * being saved, or into a group that holds as many files as allowed. Resolves whether it moved.
   */
  moveFile(from: FilePosition, toGroupIndex: number, toFileIndex: number | null = null): boolean {
    if (this.state.processing) return false
    const source = this.state.groups[from.groupIndex]
    const target = this.state.groups[toGroupIndex]
    if ([source, target].some((group) => group && this.saving.has(group.id))) return false
    if (from.groupIndex !== toGroupIndex && this.room(target?.files.length ?? 0) === 0) {
      return false
    }
    this.setGroups((groups) => moveQueueFile(groups, from, toGroupIndex, toFileIndex))
    return true
  }

  /**
   * Whether removing a file deletes a job on the server, which kiChat confirms first (T-08): it
   * has a job and its group is not saved.
   */
  removalDeletesJob(fileId: string): boolean {
    const position = findFile(this.state.groups, fileId)
    return Boolean(position?.file.jobId && !position.group.saved)
  }

  /**
   * Removes a file: its job is deleted on the server first, and only that success removes the row
   * (T-08). During a start too, which cancels the job (kiChat): its group then is not saved, and
   * the next start reuses the results of the files that stay. Resolves `false` when the deletion
   * failed. While its group is being saved (a confirmation may end after the save began) the
   * removal waits for the save; a saved group keeps the file.
   */
  async removeFile(fileId: string): Promise<boolean> {
    const position = findFile(this.state.groups, fileId)
    if (!position || position.group.saved) return true
    const saving = this.saving.get(position.group.id)
    if (saving) {
      await saving.catch(() => null)
      return this.removeFile(fileId)
    }
    const jobId = position.file.jobId
    if (jobId) {
      // The upload stops first, so it stores nothing after the deletion (T-08).
      this.abortUpload(fileId)
      if (!(await this.deleteForRemoval(fileId, jobId))) return false
      this.options.onJobsChanged?.()
    }
    this.forget(fileId)
    this.setGroups((groups) => removeQueueFile(groups, fileId))
    return true
  }

  /**
   * kiChat's `removeGroup`: deletes the jobs of all its files, then the group, during a start too.
   * Files whose job could not be deleted stay, and so does the group then; resolves `false` in
   * that case. Like `removeFile`, it waits for a save of the group under way.
   */
  async removeGroup(groupId: string): Promise<boolean> {
    const group = this.group(groupId)
    if (!group || group.saved) return true
    const saving = this.saving.get(groupId)
    if (saving) {
      await saving.catch(() => null)
      return this.removeGroup(groupId)
    }
    for (const file of group.files) if (file.jobId) this.abortUpload(file.id)
    const outcomes = await Promise.all(
      group.files.map((file) => (file.jobId ? this.deleteForRemoval(file.id, file.jobId) : true))
    )
    if (group.files.some((file) => file.jobId)) this.options.onJobsChanged?.()
    const kept = new Set(group.files.filter((_, index) => !outcomes[index]).map((file) => file.id))
    for (const file of group.files) if (!kept.has(file.id)) this.forget(file.id)
    if (kept.size > 0) {
      this.setGroups((groups) =>
        updateGroup(groups, groupId, {
          files: (this.group(groupId)?.files ?? []).filter((file) => kept.has(file.id))
        })
      )
      return false
    }
    this.setGroups((groups) => removeQueueGroup(groups, groupId))
    return true
  }

  /** Deletes a job on the server; one already gone (`404`) counts as deleted. */
  private async deleteJob(jobId: string): Promise<boolean> {
    try {
      await this.options.api.deleteJob(jobId)
      return true
    } catch (error) {
      return isGone(error)
    }
  }

  /** Deletes the job of a file being removed, noted in `removals` until the answer is there. */
  private async deleteForRemoval(fileId: string, jobId: string): Promise<boolean> {
    const deletion = this.deleteJob(jobId)
    this.removals.set(fileId, deletion)
    try {
      return await deletion
    } finally {
      if (this.removals.get(fileId) === deletion) this.removals.delete(fileId)
    }
  }

  /**
   * Whether a file whose flow lost its job still stays in the queue. A file being removed loses
   * it on purpose, and `jobRemoved` may come before the deletion's answer: the flow holds its
   * outcome until then. Once deleted, the row goes without failing first; kept because the
   * deletion failed, it fails as any other file whose job was lost, so a start waiting on it ends.
   */
  private async keptAfterRemoval(fileId: string): Promise<boolean> {
    const removal = this.removals.get(fileId)
    if (removal && (await removal)) return false
    return Boolean(this.file(fileId))
  }

  /** Stops a file's running upload; its row then shows the upload as cancelled. */
  private abortUpload(fileId: string): void {
    this.uploads.get(fileId)?.abort()
    this.uploads.delete(fileId)
  }

  /** Stops everything a file does. */
  private forget(fileId: string): void {
    this.flows.get(fileId)?.abort()
    this.flows.delete(fileId)
    this.abortUpload(fileId)
    this.stopCreep(fileId)
  }

  /** Keeps the names, colours and samples the mapping dialog saved (T-18). */
  saveVoices(fileId: string, voices: VoiceDraft[]): void {
    this.patchFile(fileId, { voices, voicesSaved: true })
  }

  /**
   * Keeps what the mapping dialog changed without Save (kiChat edits `file.speakers` in place):
   * samples, their windows, voices added or removed, colours, and names whenever kiChat's
   * `saveCurrentInputs` would run. The voices do not count as saved by it.
   */
  updateVoices(fileId: string, change: (voices: VoiceDraft[]) => VoiceDraft[]): void {
    this.patchFile(fileId, (file) => (file.voices ? { voices: change(file.voices) } : {}))
  }

  /**
   * The page shows another view. Arriving back at the entry choice clears the selection; a first
   * or repeated report of the same view (a remount of the page) does not, so jobs restored
   * meanwhile stay. Each report of the upload view restores the active jobs (kiChat's
   * `switchTranscriptView('file')`), so files cleared at the choice come back there (T-15).
   */
  showView(view: string): void {
    const previous = this.view
    this.view = view
    // What a restore lists after the upload view was left does not come back.
    if (view !== 'upload') this.cancelRestore()
    if (view === 'choice' && previous !== null && previous !== 'choice') this.resetSelection()
    if (view === 'upload' && !this.restore) this.restoration = this.restoreActiveJobs()
  }

  /**
   * Settles when the jobs listed for the upload view are back in the queue, or when that restore
   * was aborted, so recorded takes join the first group after them, as kiChat adds them 300 ms
   * after `loadActiveJobs` (T-58).
   */
  whenRestored(): Promise<void> {
    return this.restoration
  }

  /**
   * Back at the entry choice the selection is cleared unless a start runs (kiChat's
   * `resetUploadSelectionState` in `showTranscriptChoice`, T-01): saved groups and unfinished
   * files alike, so the next file starts a new transcript. The jobs stay on the server: running
   * uploads finish and start their analysis, and the next visit of the page restores them (T-15).
   */
  resetSelection(): void {
    if (this.state.processing || this.state.groups.length === 0) return
    for (const controller of this.flows.values()) controller.abort()
    this.flows.clear()
    for (const timer of this.creeps.values()) clearInterval(timer)
    this.creeps.clear()
    this.set({ ...this.state, groups: [] })
  }
}
