import {
  progressPercent,
  type TranscriptionJob,
  type TranscriptionJobStatus
} from '@justcampus/shared'
import type { StatusKey } from './queue'

/**
 * The progress a row shows, after kiChat (T-11): the upload fills 2 to 50 %, the analysis creeps
 * from 50 towards 98 % while the server reports nothing, and after dispatch preprocessing,
 * recognition and correction take the bar from 5 to 100 %. Only the chunk counts are measured; the
 * rest is an estimate.
 */

export const PROGRESS = {
  session: 2,
  uploadEnd: 50,
  analysisCreepTo: 98,
  dispatched: 5,
  preprocessingCreepFrom: 8,
  preprocessingCreepTo: 33,
  preprocessed: 35,
  transcribingBase: 40,
  transcribingSpan: 50,
  correcting: 95,
  restored: 40,
  done: 100
} as const

/** How often a creeping bar moves, in milliseconds. */
export const CREEP_MS = 500

/** The upload's share of the bar: 2 % at the start, 50 % with the last byte. */
export function uploadProgress(fraction: number): number {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0))
  return Math.round(PROGRESS.session + clamped * (PROGRESS.uploadEnd - PROGRESS.session))
}

/**
 * kiChat's `startProgressCreep`: one step towards `to`, a little less each time, so the bar keeps
 * moving without reaching it before the real status arrives. Rounded to tenths.
 */
export function creepStep(current: number, to: number): number {
  return Math.round((current + (to - current) * 0.06) * 10) / 10
}

/** What the row shows while the server transcribes. */
export interface TranscriptionDisplay {
  progress: number
  status: StatusKey
  /** The server reports nothing; the bar creeps from `progress` to `creepTo`. */
  creepTo?: number
}

/**
 * The bar and status of a dispatched job (kiChat's status loop). Chunks count from 0 of
 * `totalChunks`; a total of 0 counts as 1, so nothing divides by zero.
 */
export function transcriptionDisplay(
  job: Pick<TranscriptionJob, 'status' | 'progress'>
): TranscriptionDisplay | null {
  switch (job.status) {
    case 'preprocessing':
      return {
        progress: PROGRESS.preprocessingCreepFrom,
        status: 'preprocessing',
        creepTo: PROGRESS.preprocessingCreepTo
      }
    case 'preprocessed':
      return { progress: PROGRESS.preprocessed, status: 'preprocessing' }
    case 'transcribing':
    case 'optimizing':
      return runningDisplay(job.status, job.progress)
    default:
      return null
  }
}

function runningDisplay(
  status: TranscriptionJobStatus,
  progress: TranscriptionJob['progress']
): TranscriptionDisplay {
  const phase = progress?.phase ?? null
  if (status === 'optimizing' || phase === 'correcting' || phase === 'optimizing') {
    return { progress: PROGRESS.correcting, status: 'speakerAssignment' }
  }
  if (!progress) return { progress: PROGRESS.transcribingBase, status: 'preparing' }
  const estimate = progressPercent(progress)
  if (progress.percent !== null && estimate !== null) {
    return {
      progress: Math.round(
        PROGRESS.transcribingBase + (estimate / 100) * PROGRESS.transcribingSpan
      ),
      status: phase === 'diarizing' ? 'speakerAssignment' : 'transcribing'
    }
  }
  const total = Math.max(1, progress.totalChunks)
  const current = Math.min(progress.currentChunk, total - 1)
  const base = PROGRESS.transcribingBase + (current / total) * PROGRESS.transcribingSpan
  const step = PROGRESS.transcribingSpan / total
  if (phase === 'diarizing' || phase === 'merging') {
    // kiChat's single chunk before any counting: 90 %.
    const progressValue =
      progress.totalChunks <= 1 && progress.currentChunk === 0 ? 90 : Math.round(base + step * 0.9)
    return { progress: progressValue, status: 'speakerAssignment' }
  }
  if (phase === 'queued' || phase === 'normalizing' || phase === 'chunking') {
    return { progress: PROGRESS.transcribingBase, status: 'preparing' }
  }
  return { progress: Math.round(base + step * 0.4), status: 'transcribing' }
}
