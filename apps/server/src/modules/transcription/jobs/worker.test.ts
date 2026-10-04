import {
  TRANSCRIPTION_DEFAULT_CONFIG,
  TRANSCRIPTION_UPLOAD_URL_TTL_SECONDS
} from '@justcampus/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { TranscriptionRuntime } from '../config.js'
import { PartialDeleteError, type TranscriptionStorage } from '../storage.js'
import { UPLOAD_SETTLE_MS, uploadSettled, type JobRow } from './rows.js'
import { JobFailure } from './state.js'
import type { JobChanges } from './store.js'

const state = vi.hoisted(() => ({
  writes: [] as Array<{ id: string; claim: Date; changes: Record<string, unknown> }>,
  released: [] as string[],
  lost: false,
  purgeRows: [] as Array<{ id: string; componentId: string }>,
  deletedRows: [] as string[],
  cancelledExpired: 0
}))

vi.mock('./store.js', () => ({
  updateClaimedJob: async (id: string, claim: Date, changes: Record<string, unknown>) => {
    if (state.lost) return undefined
    state.writes.push({ id, claim, changes })
    return { id, ...changes }
  },
  renewClaim: async () => !state.lost,
  releaseClaim: async (id: string) => {
    state.released.push(id)
  },
  cancelExpiredClaims: async () => {
    state.cancelledExpired++
  },
  purgeCandidates: async () => state.purgeRows,
  deleteJobRow: async (id: string) => {
    state.deletedRows.push(id)
  },
  claimNextJob: async () => undefined
}))

const { MAX_ATTEMPTS, processJob, sweepJobs, WorkerStopped } = await import('./worker.js')

const claim = new Date('2026-10-04T08:00:00.000Z')
const runtime: TranscriptionRuntime = {
  type: 'transcription',
  componentId: 'component',
  config: TRANSCRIPTION_DEFAULT_CONFIG,
  secrets: { apiKey: null, diarizationApiKey: null, llmApiKey: null, openaiRealtimeApiKey: null }
}
const storage = {} as TranscriptionStorage

function job(status: string, attempts = 1): JobRow {
  return { id: 'job', status, attempts, claimedAt: claim, heartbeatAt: claim } as JobRow
}

function never(): Promise<JobChanges> {
  throw new Error('must not run')
}

beforeEach(() => {
  state.writes = []
  state.released = []
  state.lost = false
  state.purgeRows = []
  state.deletedRows = []
  state.cancelledExpired = 0
})

describe('processJob', () => {
  it('runs the analysis of a claimed analysis and writes its outcome with the claim given up', async () => {
    const runAnalysis = vi.fn(async () => ({ status: 'analyzed' as const, speakers: [] }))
    await processJob(job('analyzing'), runtime, storage, new AbortController(), {
      runAnalysis,
      runTranscription: never
    })
    expect(runAnalysis).toHaveBeenCalledOnce()
    expect(state.writes).toEqual([
      {
        id: 'job',
        claim,
        changes: { status: 'analyzed', speakers: [], claimedAt: null, heartbeatAt: null }
      }
    ])
  })

  it('runs the transcription after dispatch', async () => {
    const runTranscription = vi.fn(async () => ({ status: 'completed' as const }))
    await processJob(job('transcribing'), runtime, storage, new AbortController(), {
      runAnalysis: never,
      runTranscription
    })
    expect(runTranscription).toHaveBeenCalledOnce()
    expect(state.writes[0]!.changes).toMatchObject({ status: 'completed', claimedAt: null })
  })

  it('fails the job with the error the step gave', async () => {
    await processJob(job('preprocessing'), runtime, storage, new AbortController(), {
      runAnalysis: never,
      runTranscription: async () => {
        throw new JobFailure(
          'asr_failed',
          'Spracherkennung fehlgeschlagen (Server antwortete mit Status 503).'
        )
      }
    })
    const changes = state.writes[0]!.changes
    expect(changes).toMatchObject({
      status: 'failed',
      error: {
        code: 'asr_failed',
        message: 'Spracherkennung fehlgeschlagen (Server antwortete mit Status 503).'
      },
      claimedAt: null
    })
    // A failed job goes after the unsaved-job retention.
    expect((changes.expiresAt as Date).getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000)
  })

  it('gives up after repeated interruptions', async () => {
    await processJob(job('analyzing', MAX_ATTEMPTS + 1), runtime, storage, new AbortController(), {
      runAnalysis: never,
      runTranscription: never
    })
    expect(state.writes[0]!.changes).toMatchObject({
      status: 'failed',
      error: { code: 'analysis_failed' }
    })
    await processJob(
      job('transcribing', MAX_ATTEMPTS + 1),
      runtime,
      storage,
      new AbortController(),
      {
        runAnalysis: never,
        runTranscription: never
      }
    )
    expect(state.writes[1]!.changes).toMatchObject({ error: { code: 'internal' } })
  })

  it('stops a deleted job without writing an outcome', async () => {
    await processJob(job('transcribing'), runtime, storage, new AbortController(), {
      runAnalysis: never,
      runTranscription: async (run) => {
        state.lost = true
        await run.update({ progress: null })
        return { status: 'completed' }
      }
    })
    expect(state.writes).toEqual([])
    expect(state.released).toEqual(['job'])
  })

  it('hands the job back when the worker stops', async () => {
    const controller = new AbortController()
    await processJob(job('transcribing'), runtime, storage, controller, {
      runAnalysis: never,
      runTranscription: async (run) => {
        controller.abort(new WorkerStopped())
        throw run.signal.reason
      }
    })
    expect(state.writes).toEqual([])
    expect(state.released).toEqual(['job'])
  })
})

describe('sweepJobs', () => {
  it('deletes the objects, then the row, of deleted and expired jobs', async () => {
    state.purgeRows = [
      { id: 'a', componentId: 'c' },
      { id: 'b', componentId: 'c' }
    ]
    const deletePrefix = vi
      .fn()
      .mockResolvedValueOnce(2)
      .mockRejectedValueOnce(
        new PartialDeleteError('transcription/c/jobs/b/', [
          { key: 'transcription/c/jobs/b/source', code: 'AccessDenied' }
        ])
      )
    const purged = await sweepJobs({ deletePrefix } as unknown as TranscriptionStorage, 24)
    expect(purged).toBe(1)
    expect(deletePrefix).toHaveBeenNthCalledWith(1, 'transcription/c/jobs/a/')
    expect(deletePrefix).toHaveBeenNthCalledWith(2, 'transcription/c/jobs/b/')
    // The row whose objects could not go stays for the next sweep.
    expect(state.deletedRows).toEqual(['a'])
    expect(state.cancelledExpired).toBe(1)
  })

  it('waits for a signed upload to settle before a row may go (T-08)', () => {
    const now = new Date('2026-10-04T12:00:00.000Z')
    // The URL lives an hour; a PUT started just before then may still be transferring.
    expect(UPLOAD_SETTLE_MS).toBeGreaterThan(TRANSCRIPTION_UPLOAD_URL_TTL_SECONDS * 1000)
    expect(uploadSettled(new Date(now.getTime() - UPLOAD_SETTLE_MS), now)).toBe(true)
    expect(uploadSettled(new Date(now.getTime() - UPLOAD_SETTLE_MS + 1), now)).toBe(false)
    expect(
      uploadSettled(new Date(now.getTime() - TRANSCRIPTION_UPLOAD_URL_TTL_SECONDS * 1000), now)
    ).toBe(false)
  })
})
