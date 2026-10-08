import { createContext, useContext } from 'react'
import type { TranscriptionRealtimeConfig, TranscriptionRealtimeMode } from '@justcampus/shared'
import type { LiveTranscriptWindow } from '../live/lines'
import type { StoredRecording } from './backup-store'
import type { DisplaySupport } from './display-capture'
import type { RecordingSource, SourceAnnouncement, SourceKind } from './sources'
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
  /**
   * Each source on its own beside the mix (`tracks.ts`), by start; none when the take had one
   * source at a time. Only the mix is uploaded.
   */
  tracks?: readonly RecordedTrack[]
}

/** One source of a take, recorded on its own. */
export interface RecordedTrack {
  id: string
  file: File
  /** The source's name. */
  label: string
  kind: SourceKind
  /** Seconds into the take where the track starts. */
  offset: number
  /** Seconds. */
  duration: number
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

/** A microphone to add or switch to, named as the card shows it. */
export interface MicrophoneOption {
  deviceId: string
  label: string
}

/** What regular recording mixes, and adding to it and removing from it. */
export interface RecordingSources {
  /** Every source, the main microphone first (`MAIN_SOURCE_ID`) unless there is none. */
  list: readonly RecordingSource[]
  /** Whether a source may be removed: not the last one. */
  removable: boolean
  /** The last change, for a polite announcement; an ended source also shows a notice. */
  announcement: SourceAnnouncement | null
  dismissAnnouncement: () => void
  /** Why the last source could not be added or opened. */
  error: string | null
  /** Whether a tab, window or screen can be shared here. */
  displaySupport: DisplaySupport
  /** Input devices not in use, the browser's default input first. */
  addableMicrophones: readonly MicrophoneOption[]
  /** Adds a microphone; without a main microphone it becomes the main one. */
  addMicrophone: (deviceId: string) => void
  /** Opens the browser's picker; call it straight from the click. */
  addDisplay: () => void
  /**
   * Removes a source. The main microphone hands over to the first added microphone, else the take
   * goes on without one.
   */
  remove: (id: string) => void
}

/** Live transcription's one microphone, and the others it can switch to. */
export interface LiveMicrophone {
  current: MicrophoneOption
  others: readonly MicrophoneOption[]
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
  /** Without a main microphone, live transcription takes the browser's default input. */
  liveMicrophone: LiveMicrophone
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
