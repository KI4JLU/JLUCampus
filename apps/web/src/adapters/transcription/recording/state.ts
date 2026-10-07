/**
 * The recording lifecycle shared by regular recording, live transcription and meetings (T-56,
 * T-60), after kiChat's `liveRecordingStatus`: `requesting` while the microphone (for a meeting
 * first the meeting's tab) is asked for (and, live, the connection is set up), `recording`,
 * `stopping` while the last audio is collected and converted, then `ready` with takes, `idle`
 * without, or `error`. `error` is recoverable: recording can start again from it, as from `idle`
 * and `ready`.
 */

export type RecordingStatus = 'idle' | 'requesting' | 'recording' | 'stopping' | 'ready' | 'error'

/**
 * Regular recording, live transcription that records the same microphone alongside, or a meeting:
 * the microphone and another tab's audio, mixed.
 */
export type RecordingKind = 'record' | 'live' | 'meeting'

/** What `requesting` waits for: the meeting's tab, the microphone, or the live connection. */
export type RecordingStep = 'display' | 'microphone' | 'connecting'

export interface RecordingState {
  status: RecordingStatus
  /** What runs, or ran last. */
  kind: RecordingKind | null
  /** While `requesting`: what is asked for or set up. */
  step: RecordingStep | null
  /** When the running recording started, in milliseconds since the epoch. */
  startedAt: number | null
  /** What went wrong, shown until the next start. */
  error: string | null
}

export type RecordingAction =
  | { type: 'request'; kind: RecordingKind }
  | { type: 'connect' }
  | { type: 'microphone' }
  | { type: 'started'; at: number }
  | { type: 'stop' }
  | { type: 'stopped'; takes: number }
  | { type: 'failed'; error: string; takes: number }
  | { type: 'takesChanged'; takes: number }

export const INITIAL_RECORDING_STATE: RecordingState = {
  status: 'idle',
  kind: null,
  step: null,
  startedAt: null,
  error: null
}

/** Whether the microphone is being asked for, recorded or released: selectors stay locked. */
export function isRecordingBusy(status: RecordingStatus): boolean {
  return status === 'requesting' || status === 'recording' || status === 'stopping'
}

/** The resting state for this many takes. */
function rest(takes: number): Pick<RecordingState, 'status' | 'step' | 'startedAt'> {
  return { status: takes > 0 ? 'ready' : 'idle', step: null, startedAt: null }
}

export function recordingReducer(state: RecordingState, action: RecordingAction): RecordingState {
  switch (action.type) {
    case 'request':
      if (isRecordingBusy(state.status)) return state
      return {
        status: 'requesting',
        kind: action.kind,
        // The tab comes first: Chrome only offers it within the click (see `meeting-capture.ts`).
        step: action.kind === 'meeting' ? 'display' : 'microphone',
        startedAt: null,
        error: null
      }
    case 'connect':
      return state.status === 'requesting' ? { ...state, step: 'connecting' } : state
    case 'microphone':
      return state.status === 'requesting' ? { ...state, step: 'microphone' } : state
    case 'started':
      return state.status === 'requesting'
        ? { ...state, status: 'recording', step: null, startedAt: action.at }
        : state
    case 'stop':
      return state.status === 'recording' ? { ...state, status: 'stopping' } : state
    case 'stopped':
      return state.status === 'stopping' ? { ...state, ...rest(action.takes) } : state
    case 'failed':
      return { ...state, status: 'error', step: null, startedAt: null, error: action.error }
    case 'takesChanged':
      if (isRecordingBusy(state.status) || state.status === 'error') return state
      return { ...state, ...rest(action.takes) }
  }
}
