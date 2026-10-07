import { createContext, useContext } from 'react'
import type { TranscriptionRealtimeConfig, TranscriptionRealtimeMode } from '@justcampus/shared'
import type { MeetingSupport } from './meeting-capture'
import type { StoredMeeting } from './meeting-store'
import type { RecordingKind, RecordingState } from './state'
import type { Microphones } from './use-microphones'

/**
 * One recorded take, kept in memory (T-57): a real WAV file, or a meeting's WebM file, which is
 * also backed up in the browser's storage until it is uploaded or deleted.
 */
export interface RecordedTake {
  id: string
  file: File
  /** Seconds, from the recording's running time; recorded WebM names no duration of its own. */
  duration?: number
  /** The meeting's backup in the browser (`meeting-store.ts`). */
  meetingId?: string
}

/** The meeting tab: tab audio and microphone, mixed into one take. */
export interface MeetingRecording {
  support: MeetingSupport
  /** Everyone in the meeting agreed; asked again for every recording. */
  consented: boolean
  setConsented: (consented: boolean) => void
  /** The backup in the browser failed for the running or last meeting; the take is complete. */
  backupFailed: boolean
  /** Recordings a crash, reload or leaving the page left in the backup. */
  leftovers: readonly StoredMeeting[]
  /** Adds a leftover to the takes. */
  restore: (id: string) => Promise<void>
  /** Deletes a leftover from the backup. */
  discard: (id: string) => Promise<void>
  /** Why the last restore or discard failed. */
  leftoverError: string | null
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
  /** Starts regular recording, live transcription or a meeting; ignored while busy. */
  start: (kind: RecordingKind) => Promise<void>
  /** Stops what runs; repeated calls join the first. */
  stop: () => Promise<void>
  deleteTake: (id: string) => void
  /** Hands every take to the upload queue as one group and clears the list (T-58). */
  uploadTakes: () => void
  live: LiveTranscription
  meeting: MeetingRecording
}

/** Provided by `RecordingProvider`. */
export const RecordingContext = createContext<Recording | null>(null)

/** Microphone, takes and live session of the transcription page; only inside `RecordingProvider`. */
export function useRecording(): Recording {
  const recording = useContext(RecordingContext)
  if (!recording) throw new Error('useRecording outside RecordingProvider')
  return recording
}
