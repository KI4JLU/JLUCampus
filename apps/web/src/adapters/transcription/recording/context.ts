import { createContext, useContext } from 'react'
import type { TranscriptionRealtimeConfig, TranscriptionRealtimeMode } from '@justcampus/shared'
import type { LiveTranscriptWindow } from '../live/lines'
import type { StoredRecording } from './backup-store'
import type { MicrophoneChoice } from './devices'
import type { DisplaySupport } from './display-capture'
import type { RecordingSource, SourceAnnouncement } from './sources'
import type { RecordingKind, RecordingState } from './state'
import type { Microphones } from './use-microphones'

/**
 * One recorded take, kept in memory (T-57) in the recorder's own format, and backed up in the
 * browser's storage until it is uploaded or deleted.
 */
export interface RecordedTake {
  id: string
  file: File
  /** Seconds, from the recording's running time; recorded WebM names no duration of its own. */
  duration?: number
  /** The take's backup in the browser (`backup-store.ts`); none for a take that failed it. */
  backupId?: string
}

/** The crash backup of the takes (`backup-store.ts`). */
export interface RecordingBackup {
  /** The backup in the browser failed for the running or last take; the take is complete. */
  failed: boolean
  /** Recordings a crash, reload or leaving the page left in the backup. */
  leftovers: readonly StoredRecording[]
  /** Adds a leftover to the takes. */
  restore: (id: string) => Promise<void>
  /** Deletes a leftover from the backup. */
  discard: (id: string) => Promise<void>
  /** Why the last restore or discard failed. */
  leftoverError: string | null
}

/** What regular recording mixes besides the main microphone, and adding to it. */
export interface RecordingSources {
  list: readonly RecordingSource[]
  /** The last change, for a polite announcement; an ended source also shows a notice. */
  announcement: SourceAnnouncement | null
  dismissAnnouncement: () => void
  /** Why the last source could not be added or opened. */
  error: string | null
  /** Whether a tab, window or screen can be shared here. */
  displaySupport: DisplaySupport
  /** Input devices that are neither the main microphone nor added. */
  addableMicrophones: readonly MicrophoneChoice[]
  addMicrophone: (choice: MicrophoneChoice) => void
  /** Opens the browser's picker; call it straight from the click. */
  addDisplay: () => void
  remove: (id: string) => void
}

/** How the live transcript is shown (T-61). None of it changes the text. */
export interface LiveAppearance {
  /**
   * `TRANSCRIPTION_LIVE_FONT_SIZE`: CSS pixels at a panel 1280 px wide, scaling with the panel's
   * width as kiChat's `--live-font-size` does.
   */
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
  /** The last lines of `text` as subtitles: what the transcript panel shows (T-61). */
  subtitles: LiveTranscriptWindow
  /** Whether a live session started since the page opened; the sample text shows until then. */
  started: boolean
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
  /** Chooses the main microphone; while regular recording runs, it is swapped in the mix. */
  selectMicrophone: (deviceId: string) => void
  sources: RecordingSources
  takes: readonly RecordedTake[]
  /** Starts regular recording or live transcription; ignored while busy. */
  start: (kind: RecordingKind) => Promise<void>
  /** Stops what runs; repeated calls join the first. */
  stop: () => Promise<void>
  deleteTake: (id: string) => void
  /** Hands every take to the upload queue as one group and clears the list (T-58). */
  uploadTakes: () => void
  live: LiveTranscription
  backup: RecordingBackup
}

/** Provided by `RecordingProvider`. */
export const RecordingContext = createContext<Recording | null>(null)

/** Sources, takes and live session of the transcription page; only inside `RecordingProvider`. */
export function useRecording(): Recording {
  const recording = useContext(RecordingContext)
  if (!recording) throw new Error('useRecording outside RecordingProvider')
  return recording
}
