import {
  TRANSCRIPTION_UNSAVED_JOB_TTL_HOURS,
  type TranscriptionJobStatus
} from '@justcampus/shared'

import { loadTranscriptionRuntime, type TranscriptionRuntime } from '../config.js'
import { objectKeys, transcriptionStorage, type TranscriptionStorage } from '../storage.js'
import { sweepOrphanObjects } from './orphans.js'
import { runAnalysis, runTranscription, type JobRun } from './pipeline.js'
import { jobExpiry, type JobRow } from './rows.js'
import { failureOf, JobFailure, stageOf } from './state.js'
import {
  cancelExpiredClaims,
  claimNextJob,
  deleteJobRow,
  purgeCandidates,
  releaseClaim,
  renewClaim,
  updateClaimedJob,
  type JobChanges
} from './store.js'

/**
 * The durable job worker. Jobs live in Postgres; a worker claims one (`claimed_at`) and renews
 * the claim every `HEARTBEAT_MS`. A claim not renewed within `CLAIM_LEASE_MS` is stale, and any
 * server process takes the job up again; after `MAX_ATTEMPTS` claims it fails instead. Ticks never
 * overlap; each claims jobs while fewer than `workerConcurrency` run in this process. Deleting a
 * job stops its run at the next renewal or write. Every minute a sweep deletes the objects and
 * rows of deleted, expired and orphaned jobs, then the orphan sweep deletes one listing page's
 * worth of objects whose job is gone (`sweepOrphanObjects`).
 */

export const CLAIM_LEASE_MS = 2 * 60_000
const HEARTBEAT_MS = 15_000
const TICK_MS = 2_000
const SWEEP_MS = 60_000
/** Claims of one stage before the job fails: the first try and two after interruptions. */
export const MAX_ATTEMPTS = 3

/** The job was deleted, expired or taken over: stop without writing an outcome. */
export class JobCancelled extends Error {
  constructor() {
    super('The job was cancelled')
    this.name = 'JobCancelled'
  }
}

/** The server stops: hand the job back for the next start. */
export class WorkerStopped extends Error {
  constructor() {
    super('The worker stopped')
    this.name = 'WorkerStopped'
  }
}

export interface WorkerDependencies {
  runAnalysis: (run: JobRun) => Promise<JobChanges>
  runTranscription: (run: JobRun) => Promise<JobChanges>
}

const pipeline: WorkerDependencies = { runAnalysis, runTranscription }

/**
 * Runs one claimed job to its end: the stage's result, `failed` with an error, or nothing when it
 * was cancelled or the worker stopped (the claim is given back then).
 */
export async function processJob(
  job: JobRow,
  runtime: TranscriptionRuntime,
  storage: TranscriptionStorage,
  controller: AbortController,
  dependencies: WorkerDependencies = pipeline
): Promise<void> {
  const claim = job.claimedAt
  if (!claim) return
  const stage = stageOf(job.status as TranscriptionJobStatus)
  const retentionHours = runtime.config.unsavedJobRetentionHours
  const fail = async (error: unknown): Promise<void> => {
    await updateClaimedJob(job.id, claim, {
      status: 'failed',
      error: failureOf(stage, error),
      claimedAt: null,
      heartbeatAt: null,
      expiresAt: jobExpiry(retentionHours)
    })
  }

  if (job.attempts > MAX_ATTEMPTS) {
    await fail(
      new JobFailure(
        stage === 'analysis' ? 'analysis_failed' : 'internal',
        'Die Verarbeitung wurde nach mehreren Unterbrechungen abgebrochen.'
      )
    )
    return
  }

  const heartbeat = setInterval(() => {
    renewClaim(job.id, claim).then(
      (held) => {
        if (!held && !controller.signal.aborted) controller.abort(new JobCancelled())
      },
      (error: unknown) => console.error('Renewing a transcription job claim failed', error)
    )
  }, HEARTBEAT_MS)
  const run: JobRun = {
    job,
    runtime,
    storage,
    signal: controller.signal,
    update: async (changes) => {
      if (controller.signal.aborted) throw controller.signal.reason
      const row = await updateClaimedJob(job.id, claim, changes)
      if (!row) {
        controller.abort(new JobCancelled())
        throw controller.signal.reason
      }
      return row
    }
  }
  try {
    const changes =
      stage === 'analysis'
        ? await dependencies.runAnalysis(run)
        : await dependencies.runTranscription(run)
    if (controller.signal.aborted) throw controller.signal.reason
    await updateClaimedJob(job.id, claim, { ...changes, claimedAt: null, heartbeatAt: null })
  } catch (error) {
    if (controller.signal.aborted) {
      await releaseClaim(job.id, claim)
      return
    }
    if (!(error instanceof JobFailure)) console.error('Transcription job failed', job.id, error)
    await fail(error)
  } finally {
    clearInterval(heartbeat)
  }
}

/**
 * Deletes the objects and rows of deleted jobs, of unsaved jobs past their expiry (T-08, kiChat's
 * 24 hours) and of jobs whose transcript is gone. A job whose objects cannot be deleted stays for
 * the next sweep.
 */
export async function sweepJobs(
  storage: TranscriptionStorage,
  retentionHours: number,
  now = new Date()
): Promise<number> {
  await cancelExpiredClaims(now)
  const orphanBefore = new Date(now.getTime() - retentionHours * 60 * 60 * 1000)
  const rows = await purgeCandidates(now, CLAIM_LEASE_MS, orphanBefore)
  let purged = 0
  for (const row of rows) {
    try {
      await storage.deletePrefix(objectKeys.jobPrefix(row.componentId, row.id))
      await deleteJobRow(row.id)
      purged++
    } catch (error) {
      console.error('Removing a transcription job failed', row.id, error)
    }
  }
  return purged
}

let wake: (() => void) | null = null

/** Looks for work at once, e.g. after an analysis or dispatch was queued. */
export function wakeJobWorker(): void {
  wake?.()
}

/**
 * Starts the job worker (analysis, normalisation, chunking, recognition, diarisation, correction)
 * and the sweep that deletes unsaved, failed and cancelled jobs with their audio after
 * `unsavedJobRetentionHours`. Returns the function that stops both.
 */
export function startJobWorker(): () => void {
  const running = new Map<string, AbortController>()
  let busy = false
  let again = false
  let stopped = false
  let lastSweep = 0
  // Where the orphan sweep goes on; each sweep lists one page, the next one continues.
  let orphanCursor: string | null = null

  async function tick(): Promise<void> {
    if (stopped) return
    if (busy) {
      again = true
      return
    }
    busy = true
    try {
      const storage = transcriptionStorage()
      const runtime = await loadTranscriptionRuntime()
      if (runtime && storage) {
        while (!stopped && running.size < runtime.config.workerConcurrency) {
          const job = await claimNextJob(runtime.componentId, CLAIM_LEASE_MS)
          if (!job) break
          const controller = new AbortController()
          running.set(job.id, controller)
          void processJob(job, runtime, storage, controller)
            .catch((error: unknown) => console.error('Transcription job run failed', job.id, error))
            .finally(() => {
              running.delete(job.id)
              void tick()
            })
        }
      }
      if (storage && Date.now() - lastSweep >= SWEEP_MS) {
        lastSweep = Date.now()
        await sweepJobs(
          storage,
          runtime?.config.unsavedJobRetentionHours ?? TRANSCRIPTION_UNSAVED_JOB_TTL_HOURS
        )
        orphanCursor = (await sweepOrphanObjects(storage, orphanCursor)).cursor
      }
    } catch (error) {
      console.error('Transcription job worker failed', error)
    } finally {
      busy = false
      if (again && !stopped) {
        again = false
        setImmediate(() => void tick())
      }
    }
  }

  const timer = setInterval(() => void tick(), TICK_MS)
  wake = () => setImmediate(() => void tick())
  void tick()
  return () => {
    stopped = true
    wake = null
    clearInterval(timer)
    for (const controller of running.values()) controller.abort(new WorkerStopped())
  }
}
