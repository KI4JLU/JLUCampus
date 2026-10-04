import type {
  TranscriptionJobError,
  TranscriptionJobStatus,
  TranscriptionProgress
} from '@justcampus/shared'

/**
 * The job's state machine (section 3 of the requirements). kiChat's statuses map to the shared
 * camelCase ones: `analyzing_speakers_queued` → `analyzingQueued`, `analyzing_speakers` →
 * `analyzing`, `analyzed_speakers` → `analyzed`; the rest keep their names.
 *
 *   uploading → analyzingQueued → analyzing → analyzed
 *     → (dispatch) preprocessing → preprocessed → transcribing (phase transcribing, diarizing)
 *     → optimizing (phase correcting, optimizing) → completed
 *
 * Any working status may end in `failed`; deleting a job cancels it (`cancelled`).
 */

/** Statuses the worker picks up: queued ones, and running ones whose claim went stale. */
export const WORK_STATUSES = [
  'analyzingQueued',
  'analyzing',
  'preprocessing',
  'preprocessed',
  'transcribing',
  'optimizing'
] as const satisfies readonly TranscriptionJobStatus[]

export const ANALYSIS_WORK_STATUSES = [
  'analyzingQueued',
  'analyzing'
] as const satisfies readonly TranscriptionJobStatus[]

export type JobStage = 'analysis' | 'transcription'

/** Which part of the pipeline the worker runs for a claimed job of this status. */
export function stageOf(status: TranscriptionJobStatus): JobStage {
  return (ANALYSIS_WORK_STATUSES as readonly string[]).includes(status)
    ? 'analysis'
    : 'transcription'
}

/** Errors the speaker analysis ends with; every other code comes from the transcription. */
const ANALYSIS_ERROR_CODES: ReadonlySet<TranscriptionJobError['code']> = new Set([
  'upload_missing',
  'upload_size_mismatch',
  'unsupported_media',
  'too_long',
  'analysis_failed'
])

/** Whether a failed job had been analysed and dispatched, so its transcription may run again. */
export function failedAfterDispatch(error: TranscriptionJobError | null): boolean {
  return error !== null && !ANALYSIS_ERROR_CODES.has(error.code)
}

/** What a job of this status and error allows. */
export interface JobActions {
  /** `POST jobAnalyze` starts (or repeats) the speaker analysis. */
  analyze: boolean
  /** `POST jobAnalyze` changes nothing: the analysis is already queued or running. */
  analyzeRunning: boolean
  /** `POST jobDispatch` starts the transcription. */
  dispatch: boolean
}

export function jobActions(
  status: TranscriptionJobStatus,
  error: TranscriptionJobError | null
): JobActions {
  return {
    analyze: status === 'uploading' || status === 'analyzed' || status === 'failed',
    analyzeRunning: status === 'analyzingQueued' || status === 'analyzing',
    dispatch: status === 'analyzed' || (status === 'failed' && failedAfterDispatch(error))
  }
}

/** Order of the working statuses, so a resumed job never shows an earlier one again. */
const RANK: Partial<Record<TranscriptionJobStatus, number>> = {
  analyzingQueued: 1,
  analyzing: 2,
  analyzed: 3,
  preprocessing: 4,
  preprocessed: 5,
  transcribing: 6,
  optimizing: 7,
  completed: 8
}

/** The later of the current and the next status, by the pipeline's order. */
export function forwardStatus(
  current: TranscriptionJobStatus,
  next: TranscriptionJobStatus
): TranscriptionJobStatus {
  return (RANK[next] ?? 0) >= (RANK[current] ?? 0) ? next : current
}

/** Progress of a phase; chunk counters stay 0 until there are chunks (T-11). */
export function progressOf(
  phase: TranscriptionProgress['phase'],
  currentChunk = 0,
  totalChunks = 0,
  percent: number | null = null
): TranscriptionProgress {
  return {
    phase,
    currentChunk: Math.max(0, Math.min(currentChunk, totalChunks)),
    totalChunks: Math.max(0, totalChunks),
    percent: percent === null ? null : Math.max(0, Math.min(100, Math.round(percent)))
  }
}

/** A failure the worker records, with the error code the user sees. */
export class JobFailure extends Error {
  constructor(
    readonly code: TranscriptionJobError['code'],
    message: string
  ) {
    super(message)
    this.name = 'JobFailure'
  }

  toError(): TranscriptionJobError {
    return { code: this.code, message: this.message.slice(0, 2000) }
  }
}

/**
 * The error an analysis or transcription ends with. Analysis failures keep the analysis codes, so
 * `failedAfterDispatch` can tell the stages apart; everything unexpected becomes `analysis_failed`
 * or `internal` without internals in the message.
 */
export function failureOf(stage: JobStage, error: unknown): TranscriptionJobError {
  if (error instanceof JobFailure) {
    if (stage === 'analysis' && !ANALYSIS_ERROR_CODES.has(error.code)) {
      return { code: 'analysis_failed', message: error.message.slice(0, 2000) }
    }
    return error.toError()
  }
  return stage === 'analysis'
    ? { code: 'analysis_failed', message: 'Analyse fehlgeschlagen.' }
    : { code: 'internal', message: 'Die Datei konnte nicht verarbeitet werden.' }
}
