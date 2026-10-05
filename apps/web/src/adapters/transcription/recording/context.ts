import { createContext, useContext } from 'react'
import type { TranscriptionRealtimeConfig, TranscriptionRealtimeMode } from '@justcampus/shared'
import type { RecordingKind, RecordingState } from './state'
import type { Microphones } from './use-microphones'

/** One recorded take: a real WAV file, kept in memory only (T-57). */
export interface RecordedTake {
  id: string
  file: File
}

/** How the live transcript is shown (T-61). None of it changes the text. */
export interface LiveAppearance {
  /** CSS pixels, `TRANSCRIPTION_LIVE_FONT_SIZE`. */
  fontSize: number
  inverted: boolean
  maximized: boolean
}

export interface LiveTranscription {
  /** The realtime config; `undefined` while loading or without live modes. */
  config: TranscriptionRealtimeConfig | undefined
  /** The modes offered, in the server's order. */
  modes: readonly TranscriptionRealtimeMode[]
  /** The chosen mode, else the default; `null` without modes. */
  mode: TranscriptionRealtimeMode | null
  setMode: (mode: TranscriptionRealtimeMode) => void
  /** Everything transcribed in this session. */
  text: string
  /** The last service error of the running session. */
  serviceError: string | null
  clearText: () => void
  appearance: LiveAppearance
  setAppearance: (change: Partial<LiveAppearance>) => void
  resetAppearance: () => void
}

export interface Recording {
  state: RecordingState
  microphones: Microphones
  takes: readonly RecordedTake[]
  /** Starts regular recording or live transcription; ignored while busy. */
  start: (kind: RecordingKind) => Promise<void>
  /** Stops what runs; repeated calls join the first. */
  stop: () => Promise<void>
  deleteTake: (id: string) => void
  /** Hands every take to the upload queue as one group and clears the list (T-58). */
  uploadTakes: () => void
  live: LiveTranscription
}

/** Provided by `RecordingProvider`. */
export const RecordingContext = createContext<Recording | null>(null)

/** Microphone, takes and live session of the transcription page; only inside `RecordingProvider`. */
export function useRecording(): Recording {
  const recording = useContext(RecordingContext)
  if (!recording) throw new Error('useRecording outside RecordingProvider')
  return recording
}
