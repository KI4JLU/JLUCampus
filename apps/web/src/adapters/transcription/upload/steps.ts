import { PROGRESS } from './progress'
import type { QueueFile, StatusKey } from './queue'

/**
 * The four steps a file goes through on its row: the upload, the speaker analysis, the
 * transcription after the start (preprocessing and recognition), and the speaker assignment with
 * the AI correction that follows it on the server.
 */
export const FILE_STEPS = [
  'upload',
  'speakerDetection',
  'transcription',
  'speakerAssignment'
] as const
export type FileStep = (typeof FILE_STEPS)[number]
export type StepIndex = 0 | 1 | 2 | 3

/**
 * What the active step does: `running` with its own share done or, as `percent` `null`, without
 * one; `waiting` for something (the upload's start, the user's start of the transcription);
 * `error` when the file failed in it.
 */
export type StepState = 'running' | 'waiting' | 'error'

export interface FileSteps {
  /** Steps before it are done, steps after it upcoming. */
  active: StepIndex
  state: StepState
  /** The active step's own share done, 0 to 100; `null` without one. */
  percent: number | null
  /** A status that tells more than the step's name, e.g. what it waits for. */
  detail: StatusKey | null
}

/** The server's recognition fills its bar to 90 %, which the row scales into 40 to 85 % (T-11). */
const RECOGNITION_END = PROGRESS.transcribingBase + PROGRESS.transcribingSpan * 0.9

/** `value` as a share of the span from `from` to `to`, 0 to 100. */
function share(value: number, from: number, to: number): number {
  const fraction = (value - from) / (to - from)
  return Math.round(Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0)) * 100)
}

function running(
  active: StepIndex,
  percent: number | null,
  detail: StatusKey | null = null
): FileSteps {
  return { active, state: 'running', percent, detail }
}

/** What the analysis waits for or does first; its main part needs no word beside its name. */
function analysis(file: Pick<QueueFile, 'status'>): StatusKey | null {
  return file.status === 'analyzingAudio' || file.status === 'waitingForAnalysis'
    ? file.status
    : null
}

/**
 * Where a file stands in the four steps, `null` once it is completed. The upload's bytes are
 * measured; the analysis and the preprocessing only creep towards an estimate, and the speaker
 * assignment reports nothing of its own, so these have no percentage. A failed transcription no
 * longer tells in which step it failed: `previous`, the step the row showed before, does, else the
 * transcription.
 */
export function fileSteps(
  file: Pick<QueueFile, 'phase' | 'status' | 'progress' | 'uploaded'>,
  previous: StepIndex | null = null
): FileSteps | null {
  switch (file.phase) {
    case 'completed':
      return null
    case 'idle':
      return { active: 0, state: 'waiting', percent: null, detail: file.status }
    case 'uploading':
      if (file.status === 'uploadingFile') {
        return running(0, share(file.progress, PROGRESS.session, PROGRESS.uploadEnd))
      }
      // Stored, the analysis is being asked for.
      if (file.uploaded || file.status === 'analyzingAudio') return running(1, null, analysis(file))
      return running(0, null, file.status === 'creatingSession' ? file.status : null)
    case 'analyzing':
      return running(1, null, analysis(file))
    case 'ready':
      return { active: 2, state: 'waiting', percent: null, detail: 'readyForTranscription' }
    case 'analysisFailed':
      return { active: file.uploaded ? 1 : 0, state: 'error', percent: null, detail: null }
    case 'transcribing':
      switch (file.status) {
        case 'transcribing':
          return running(2, share(file.progress, PROGRESS.transcribingBase, RECOGNITION_END))
        case 'speakerAssignment':
          return running(3, null)
        case 'preprocessing':
        case 'preparing':
          return running(2, null, file.status)
        default:
          return running(2, null)
      }
    case 'failed':
      return { active: previous === 3 ? 3 : 2, state: 'error', percent: null, detail: null }
  }
}
