import { useSyncExternalStore } from 'react'
import {
  TRANSCRIPTION_SUBTITLE_WAIT_MS,
  type TranscriptionSegment,
  type TranscriptionSpeakerColorMap,
  type TranscriptionSpeakerOptimization,
  type TranscriptionSpeakerOptimizationRequest,
  type TranscriptionTranscript,
  type TranscriptionTranscriptPatch
} from '@justcampus/shared'
import { ApiRequestError } from '@/lib/api'
import type { TranscriptionEvents } from '../events'
import {
  applyOptimizedSpeakers,
  buildSpeakerBlocks,
  buildTranscriptText,
  cleanupOrphanedPlaceholders,
  popUndo,
  pushUndo,
  type EditSnapshot,
  type SpeakerBlock
} from '../segments'
import { sameContent } from './compare'

/**
 * The open transcript of the result workspace (T-22 to T-36): the segments and colours with the
 * user's edits, the undo stack, what the speaker panel hides or focuses, and the saving. The work
 * area and the side column render it from different places of the page, so it lives outside React
 * as one session per open transcript (`useResultSession`).
 *
 * Every edit is saved at once, after kiChat's `saveCurrentSegmentsToServer`, but one request at a
 * time and always with the revision the server answered last: edits made while a save runs go out
 * together afterwards. Title and subtitle are saved on their own (T-23) in the same queue. A
 * `409 conflict` that only a new title or subtitle caused (an AI subtitle, say) is resolved by
 * taking the newer revision; one with other segments waits for the user (reload or keep mine).
 */

export type SaveStatus = 'saved' | 'pending' | 'failed' | 'conflict'

export interface ResultDocument {
  segments: TranscriptionSegment[]
  speakerColors: TranscriptionSpeakerColorMap
}

export interface ResultState extends ResultDocument {
  /** The transcript with the title and subtitle shown; segments and colours are the fields above. */
  transcript: TranscriptionTranscript
  undo: readonly EditSnapshot[]
  saveStatus: SaveStatus
  /** Counts successful saves of edits, so the save control can say "Saved" for a moment. */
  savedCount: number
  /** Speakers the panel hides (T-26); their segments stay. */
  hidden: ReadonlySet<string>
  /** The speaker the panel focuses: its blocks are marked. */
  focused: string | null
  optimizing: boolean
  /** The AI subtitle of a fresh transcript is still expected (T-23). */
  awaitingSubtitle: boolean
  generatingSubtitle: boolean
  /** Only in this browser: edits are stored locally, not sent (T-39). */
  local: boolean
  /**
   * Opened from the copy this browser kept, as the server could not be reached (T-39); cleared
   * once the server answers.
   */
  keptCopy: boolean
}

/** What a session talks to; the API functions, replaceable in tests. */
export interface SessionDeps {
  patch: (id: string, patch: TranscriptionTranscriptPatch) => Promise<TranscriptionTranscript>
  get: (id: string) => Promise<TranscriptionTranscript>
  generateSubtitle: (id: string) => Promise<TranscriptionTranscript>
  optimize: (
    request: TranscriptionSpeakerOptimizationRequest
  ) => Promise<TranscriptionSpeakerOptimization>
  /** Called with every copy the server confirmed, e.g. to update the query cache. */
  onServerCopy?: (transcript: TranscriptionTranscript) => void
  /** Stores a transcript only this browser has; `false` when the browser did not take it. */
  saveLocal?: (transcript: TranscriptionTranscript) => boolean
  /** The page's event stream, which says when the AI subtitle is written (T-23). */
  events?: TranscriptionEvents
}

/** A transcript saved this long ago may still get its AI subtitle; older ones are not awaited. */
const SUBTITLE_EXPECT_MS = 10 * 60 * 1000

export type OptimizeResult = { ok: true } | { ok: false; message: string | null }

/** Edits the change functions see: the document with the blocks shown and every colour. */
export interface EditInput extends ResultDocument {
  blocks: SpeakerBlock[]
}

function isConflict(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 409
}

/** The server's message of a refused request, if it sent one. */
export function serverMessage(error: unknown): string | null {
  return error instanceof ApiRequestError ? (error.body?.error.message ?? null) : null
}

export class ResultSession {
  readonly id: string
  private state: ResultState
  /** The transcript as the server has it, as far as this session knows. */
  private base: TranscriptionTranscript
  private readonly deps: SessionDeps
  private readonly listeners = new Set<() => void>()
  private chain: Promise<void> = Promise.resolve()
  private contentQueued = false
  private dirty = false
  private closed = false
  private discarded = false
  private titleTouched = false
  private subtitleTouched = false
  private editingSubtitle = false
  private subtitleExpected = false
  /** Ends the wait for the AI subtitle while it runs. */
  private stopAwaiting: (() => void) | null = null
  /** Counts the fetches of the details while waiting, so an older answer never wins. */
  private detailFetches = 0
  private detailsTaken = 0

  constructor(
    transcript: TranscriptionTranscript,
    deps: SessionDeps,
    local = false,
    keptCopy = false
  ) {
    this.id = transcript.id
    this.base = transcript
    this.deps = deps
    this.state = {
      transcript,
      segments: cleanupOrphanedPlaceholders(transcript.segments) ?? transcript.segments,
      speakerColors: transcript.speakerColors,
      undo: [],
      saveStatus: 'saved',
      savedCount: 0,
      hidden: new Set(),
      focused: null,
      optimizing: false,
      awaitingSubtitle: false,
      generatingSubtitle: false,
      local,
      keptCopy
    }
  }

  // -------------------------------------------------------------------------
  // Store
  // -------------------------------------------------------------------------

  readonly getState = (): ResultState => this.state

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private set(change: Partial<ResultState>): void {
    this.state = { ...this.state, ...change }
    this.listeners.forEach((listener) => listener())
  }

  private setTranscript(change: Partial<TranscriptionTranscript>): void {
    this.set({ transcript: { ...this.state.transcript, ...change } })
  }

  get isClosed(): boolean {
    return this.closed
  }

  /** Stops waiting for the AI subtitle; saves already queued still finish. */
  close(): void {
    this.closed = true
    this.stopAwaiting?.()
  }

  // -------------------------------------------------------------------------
  // Edits
  // -------------------------------------------------------------------------

  /**
   * Applies an edit and saves it. `change` gets the document, its blocks and every speaker's
   * colour, and answers the new segments and/or colours, or `null` for nothing to do. Structural
   * edits are undoable (T-34); text corrections and colours are not, as in kiChat. Placeholders
   * that are no longer alone go after an edit (kiChat cleans them up when it renders the
   * transcript again), except after a text correction (`cleanup: false`): a segment emptied there
   * keeps its placeholder, so its text can be typed in again (T-27).
   */
  edit(
    change: (input: EditInput) => Partial<ResultDocument> | null,
    options: { undoable: boolean; cleanup?: boolean } = { undoable: true }
  ): boolean {
    const { segments, speakerColors, undo } = this.state
    const { blocks, speakerColors: colors } = buildSpeakerBlocks(segments, speakerColors)
    const result = change({ segments, speakerColors: colors, blocks })
    if (!result) return false
    const cleanup = options.cleanup ?? true
    const nextSegments = result.segments
      ? cleanup
        ? (cleanupOrphanedPlaceholders(result.segments) ?? result.segments)
        : result.segments
      : segments
    this.set({
      segments: nextSegments,
      speakerColors: result.speakerColors ?? colors,
      undo: options.undoable ? pushUndo(undo, { segments, speakerColors }) : undo
    })
    this.queueContentSave()
    return true
  }

  /** Restores the snapshot before the last structural edit and saves it (T-34). */
  undo(): boolean {
    const popped = popUndo(this.state.undo)
    if (!popped) return false
    this.set({
      segments: [...popped.snapshot.segments],
      speakerColors: popped.snapshot.speakerColors,
      undo: popped.stack
    })
    this.queueContentSave()
    return true
  }

  setHidden(hidden: ReadonlySet<string>): void {
    this.set({ hidden })
  }

  setFocused(focused: string | null): void {
    this.set({ focused })
  }

  // -------------------------------------------------------------------------
  // Saving
  // -------------------------------------------------------------------------

  /** Runs a task after every task queued before it; the queue goes on when one fails. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task)
    this.chain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  /** Resolves once nothing is queued or running any more (the save control awaits it, T-35). */
  async flush(): Promise<void> {
    let current: Promise<void>
    do {
      current = this.chain
      await current
    } while (current !== this.chain)
  }

  /** Whether edits have not reached the server (yet). */
  hasUnsavedChanges(): boolean {
    if (this.discarded) return false
    return this.dirty || this.contentQueued || this.state.saveStatus !== 'saved'
  }

  /** Drops the session's unsaved edits, e.g. once the transcript is deleted (T-40). */
  discard(): void {
    this.discarded = true
    this.dirty = false
    this.close()
  }

  private queueContentSave(): void {
    this.dirty = true
    if (this.state.local) {
      this.saveLocally()
      return
    }
    this.set({ saveStatus: 'pending' })
    if (this.contentQueued) return
    this.contentQueued = true
    void this.enqueue(() => this.saveContent())
  }

  /** Saves the edits again after a failure (T-35). */
  retry(): void {
    if (this.state.saveStatus === 'failed') this.queueContentSave()
  }

  private async saveContent(retried = false): Promise<void> {
    this.contentQueued = false
    if (!this.dirty || this.discarded) return
    this.dirty = false
    const segments = this.state.segments
    const speakerColors = buildSpeakerBlocks(segments, this.state.speakerColors).speakerColors
    try {
      const saved = await this.deps.patch(this.id, {
        baseRevision: this.base.revision,
        segments,
        speakerColors
      })
      this.takeServerCopy(saved)
      this.setTranscript({
        revision: saved.revision,
        updatedAt: saved.updatedAt,
        text: saved.text,
        expiresAt: saved.expiresAt
      })
      if (!this.dirty && !this.contentQueued) {
        this.set({ saveStatus: 'saved', savedCount: this.state.savedCount + 1 })
      }
    } catch (error) {
      this.dirty = true
      if (isConflict(error) && !retried && (await this.resolveConflict())) {
        return this.saveContent(true)
      }
      if (!this.contentQueued) this.set({ saveStatus: isConflict(error) ? 'conflict' : 'failed' })
    }
  }

  private takeServerCopy(transcript: TranscriptionTranscript): void {
    this.base = transcript
    this.deps.onServerCopy?.(transcript)
    if (this.state.keptCopy) this.set({ keptCopy: false })
  }

  /**
   * After a `409`: takes the server's newer revision when it differs only in its details, which
   * it adopts unless the user changed them. `false` when its segments or colours differ.
   */
  private async resolveConflict(): Promise<boolean> {
    let latest: TranscriptionTranscript
    try {
      latest = await this.deps.get(this.id)
    } catch {
      return false
    }
    if (!sameContent(latest, this.base)) return false
    this.adoptDetails(latest)
    return true
  }

  /** Takes a server copy with the same content: its revision, and title and subtitle if untouched. */
  private adoptDetails(latest: TranscriptionTranscript): void {
    this.takeServerCopy(latest)
    const change: Partial<TranscriptionTranscript> = {
      revision: latest.revision,
      updatedAt: latest.updatedAt
    }
    if (!this.titleTouched) change.title = latest.title
    if (!this.subtitleTouched && !this.editingSubtitle && latest.subtitle) {
      change.subtitle = latest.subtitle
      change.subtitleSource = latest.subtitleSource
    }
    this.setTranscript(change)
  }

  /** Discards the local edits for the server's copy (after a conflict). */
  async reload(): Promise<boolean> {
    let latest: TranscriptionTranscript
    try {
      latest = await this.deps.get(this.id)
    } catch {
      return false
    }
    await this.flush()
    this.dirty = false
    this.titleTouched = false
    this.subtitleTouched = false
    this.takeServerCopy(latest)
    this.set({
      transcript: latest,
      segments: cleanupOrphanedPlaceholders(latest.segments) ?? latest.segments,
      speakerColors: latest.speakerColors,
      undo: [],
      saveStatus: 'saved'
    })
    return true
  }

  /** Saves the local edits over the server's copy (after a conflict). */
  async overwrite(): Promise<boolean> {
    let latest: TranscriptionTranscript
    try {
      latest = await this.deps.get(this.id)
    } catch {
      return false
    }
    this.base = latest
    this.queueContentSave()
    return true
  }

  /**
   * Sends a title or subtitle change. A conflict is retried on the newest revision, which only
   * becomes the session's own when the segments did not change meanwhile; otherwise the next save
   * of edits reports the conflict.
   */
  private async patchDetails(
    fields: Pick<TranscriptionTranscriptPatch, 'title' | 'subtitle'>
  ): Promise<TranscriptionTranscript> {
    try {
      const saved = await this.deps.patch(this.id, { baseRevision: this.base.revision, ...fields })
      this.takeServerCopy(saved)
      return saved
    } catch (error) {
      if (!isConflict(error)) throw error
      const latest = await this.deps.get(this.id)
      const saved = await this.deps.patch(this.id, { baseRevision: latest.revision, ...fields })
      if (sameContent(latest, this.base)) this.takeServerCopy(saved)
      else this.deps.onServerCopy?.(saved)
      return saved
    }
  }

  /** Renames the transcript (T-23); `false` when the server refused, the old title is back then. */
  async setTitle(title: string): Promise<boolean> {
    const next = title.trim()
    const previous = this.state.transcript.title
    if (!next || next === previous) return true
    this.titleTouched = true
    this.setTranscript({ title: next })
    // Not stored locally, the title stays shown and unsaved until a retry stores it.
    if (this.state.local) return this.saveLocally()
    return this.enqueue(async () => {
      try {
        const saved = await this.patchDetails({ title: next })
        this.setTranscript({ title: saved.title, revision: this.base.revision })
        return true
      } catch {
        this.setTranscript({ title: previous })
        return false
      }
    })
  }

  /** Sets the subtitle; empty removes it (T-23). `false` when the server refused. */
  async setSubtitle(subtitle: string): Promise<boolean> {
    const next = subtitle.trim()
    const previous = this.state.transcript
    if (next === (previous.subtitle ?? '')) return true
    this.subtitleTouched = true
    this.stopAwaiting?.()
    this.setTranscript({ subtitle: next || null, subtitleSource: next ? 'manual' : null })
    if (this.state.local) return this.saveLocally()
    return this.enqueue(async () => {
      try {
        const saved = await this.patchDetails({ subtitle: next })
        this.setTranscript({
          subtitle: saved.subtitle,
          subtitleSource: saved.subtitleSource,
          revision: this.base.revision
        })
        return true
      } catch {
        this.setTranscript({ subtitle: previous.subtitle, subtitleSource: previous.subtitleSource })
        return false
      }
    })
  }

  /** While the subtitle is being edited, an AI subtitle does not replace it. */
  setEditingSubtitle(editing: boolean): void {
    this.editingSubtitle = editing
  }

  /** Has the chat model write a new subtitle. `false` when it failed. */
  async generateSubtitle(): Promise<boolean> {
    if (this.state.local || this.state.generatingSubtitle) return false
    this.set({ generatingSubtitle: true })
    try {
      return await this.enqueue(async () => {
        const saved = await this.deps.generateSubtitle(this.id)
        if (sameContent(saved, this.base)) this.takeServerCopy(saved)
        else this.deps.onServerCopy?.(saved)
        this.subtitleTouched = false
        this.setTranscript({
          subtitle: saved.subtitle,
          subtitleSource: saved.subtitleSource,
          revision: this.base.revision
        })
        if (saved.subtitle) this.stopAwaiting?.()
        return true
      })
    } catch {
      return false
    } finally {
      this.set({ generatingSubtitle: false })
    }
  }

  /**
   * Waits for the AI subtitle of a transcript saved in the last minutes that has none yet; call it
   * when the module writes subtitles. Once per session.
   */
  expectSubtitle(): void {
    const { transcript, local, keptCopy } = this.state
    const events = this.deps.events
    if (this.subtitleExpected || this.closed || local || keptCopy || transcript.subtitle) return
    if (!events || Date.now() - Date.parse(transcript.createdAt) >= SUBTITLE_EXPECT_MS) return
    this.subtitleExpected = true
    this.awaitSubtitle(events)
  }

  /**
   * kiChat's `pollForTitleUpdate`, without the polling: the chat model writes the AI subtitle (and
   * title) of a new transcript after saving, and a `transcriptMetadata` event says it is done. The
   * detail is fetched then, and once after each (re)connect of the stream in case the event came
   * before. What the user typed in the meantime wins. The wait ends once the subtitle is there,
   * after the event's fetch, or after `TRANSCRIPTION_SUBTITLE_WAIT_MS`.
   */
  private awaitSubtitle(events: TranscriptionEvents): void {
    this.set({ awaitingSubtitle: true })
    const timer = setTimeout(() => this.stopAwaiting?.(), TRANSCRIPTION_SUBTITLE_WAIT_MS)
    const unsubscribe = events.subscribe({
      onOpen: () => void this.fetchDetails(false),
      onEvent: (event) => {
        if (event.type === 'transcriptMetadata' && event.data.id === this.id) {
          void this.fetchDetails(true)
        }
      }
    })
    this.stopAwaiting = () => {
      this.stopAwaiting = null
      clearTimeout(timer)
      unsubscribe()
      this.set({ awaitingSubtitle: false })
    }
  }

  /** Fetches the detail while waiting for the AI subtitle; `final` after the chat model is done. */
  private async fetchDetails(final: boolean): Promise<void> {
    const order = ++this.detailFetches
    let latest: TranscriptionTranscript
    try {
      latest = await this.deps.get(this.id)
    } catch {
      // The next connect of the stream or the event fetches again.
      return
    }
    if (!this.stopAwaiting || order < this.detailsTaken) return
    this.detailsTaken = order
    // The module writes the AI subtitle without a new revision; a newer one is fine too, as long as
    // only details changed.
    if (latest.revision >= this.base.revision && sameContent(latest, this.base)) {
      this.adoptDetails(latest)
    }
    if (final || this.state.transcript.subtitle || this.subtitleTouched) this.stopAwaiting?.()
  }

  // -------------------------------------------------------------------------
  // AI speaker optimisation (T-36)
  // -------------------------------------------------------------------------

  /**
   * Has the chat model reassign speakers; the answer becomes an undoable edit. Only the speakers
   * are taken from it: segments the user changed while it ran keep the user's version, and what
   * was not changed gets its new speaker by segment id (T-36).
   */
  async optimizeSpeakers(): Promise<OptimizeResult> {
    if (this.state.optimizing || this.state.segments.length === 0)
      return { ok: false, message: null }
    this.set({ optimizing: true })
    const sent = this.state.segments
    try {
      const result = await this.deps.optimize({
        segments: sent,
        transcriptId: this.state.local ? null : this.id
      })
      if (this.discarded) return { ok: false, message: null }
      this.edit(
        ({ segments }) => {
          const next = applyOptimizedSpeakers(segments, sent, result.segments)
          return next ? { segments: next } : null
        },
        { undoable: true }
      )
      return { ok: true }
    } catch (error) {
      return { ok: false, message: serverMessage(error) }
    } finally {
      this.set({ optimizing: false })
    }
  }

  // -------------------------------------------------------------------------
  // Local transcripts (T-39)
  // -------------------------------------------------------------------------

  /**
   * Stores the whole transcript, title and subtitle included, in this browser. When the browser
   * does not take it (full or blocked storage) the edits stay here, unsaved: the save state says
   * so, leaving asks first, and a retry stores everything again. `false` then.
   */
  private saveLocally(): boolean {
    if (this.discarded) return true
    const { transcript, segments, speakerColors } = this.state
    const colors = buildSpeakerBlocks(segments, speakerColors).speakerColors
    const stored =
      this.deps.saveLocal?.({
        ...transcript,
        segments,
        speakerColors: colors,
        text: buildTranscriptText(segments),
        updatedAt: new Date().toISOString()
      }) ?? false
    this.dirty = !stored
    if (stored) this.set({ saveStatus: 'saved', savedCount: this.state.savedCount + 1 })
    else this.set({ saveStatus: 'failed' })
    return stored
  }
}

// ---------------------------------------------------------------------------
// The open session
// ---------------------------------------------------------------------------

let current: ResultSession | null = null
const registry = new Set<() => void>()

function emit(): void {
  registry.forEach((listener) => listener())
}

/** The session of a transcript, created once per opening. */
export function ensureResultSession(
  transcript: TranscriptionTranscript,
  deps: SessionDeps,
  local = false,
  keptCopy = false
): ResultSession {
  if (current && current.id === transcript.id && !current.isClosed) return current
  current?.close()
  current = new ResultSession(transcript, deps, local, keptCopy)
  emit()
  return current
}

/** Closes the session of a transcript when the result view leaves it. */
export function closeResultSession(id: string): void {
  if (current?.id !== id) return
  current.close()
  current = null
  emit()
}

function subscribeRegistry(listener: () => void): () => void {
  registry.add(listener)
  return () => registry.delete(listener)
}

/** The open transcript's session, or `null` while none is open. */
export function useResultSession(): ResultSession | null {
  return useSyncExternalStore(
    subscribeRegistry,
    () => current,
    () => null
  )
}

/** The state of a session, following its changes. */
export function useResultState(session: ResultSession): ResultState {
  return useSyncExternalStore(session.subscribe, session.getState, session.getState)
}
