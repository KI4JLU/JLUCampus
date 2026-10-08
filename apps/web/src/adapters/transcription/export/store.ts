import { useSyncExternalStore } from 'react'
import {
  TRANSCRIPT_DEFAULT_PRESET,
  type TranscriptFormatFlags,
  type TranscriptionFormat,
  type TranscriptPresetId
} from '@justcampus/shared'
import {
  DEFAULT_DOCUMENT_FORMAT,
  DEFAULT_SUBTITLE_FORMAT,
  type DocumentFormat,
  type ExportCategory,
  type SubtitleFormat
} from './files'
import type { VisibleSpeakers } from './format'
import { onSignOut } from '@/lib/sign-out-cleanups'
import { flagsOf, presetFlags, type TranscriptFormatChoice } from './presets'

/**
 * A small external store: the export's work area and the settings in the side column are apart in
 * the page, so they share their state here rather than through props. It lives as long as the
 * app, like kiChat's page state, and holds no transcript content.
 */
export interface Store<T> {
  get: () => T
  set: (change: Partial<T> | ((state: T) => Partial<T>)) => void
  subscribe: (listener: () => void) => () => void
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial
  const listeners = new Set<() => void>()
  return {
    get: () => state,
    set: (change) => {
      const patch = typeof change === 'function' ? change(state) : change
      state = { ...state, ...patch }
      listeners.forEach((listener) => listener())
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}

export interface ExportState {
  category: ExportCategory
  /** Summary and transcript share the document format, as in kiChat. */
  documentFormat: DocumentFormat
  subtitleFormat: SubtitleFormat
  flags: TranscriptFormatFlags
  choice: TranscriptFormatChoice
  /** The saved format a save changes: the one chosen last, until a preset is chosen (T-45). */
  editingFormatId: string | null
  /** Which speakers the transcript export shows, per transcript; never saved with a format. */
  visibleSpeakers: Readonly<Record<string, VisibleSpeakers>>
  /** Counts preset and format choices; each one starts the format name field afresh. */
  formatChoices: number
}

const INITIAL: ExportState = {
  category: 'summary',
  documentFormat: DEFAULT_DOCUMENT_FORMAT,
  subtitleFormat: DEFAULT_SUBTITLE_FORMAT,
  flags: presetFlags(TRANSCRIPT_DEFAULT_PRESET),
  choice: { kind: 'preset', id: TRANSCRIPT_DEFAULT_PRESET },
  editingFormatId: null,
  visibleSpeakers: {},
  formatChoices: 0
}

export const exportStore = createStore<ExportState>(INITIAL)

export function useExportState(): ExportState {
  return useStore(exportStore)
}

export const exportActions = {
  setCategory: (category: ExportCategory): void => exportStore.set({ category }),
  setDocumentFormat: (documentFormat: DocumentFormat): void => exportStore.set({ documentFormat }),
  setSubtitleFormat: (subtitleFormat: SubtitleFormat): void => exportStore.set({ subtitleFormat }),

  /** Sets every flag of a preset (T-44) and stops changing a saved format. */
  choosePreset: (id: TranscriptPresetId): void =>
    exportStore.set((state) => ({
      flags: presetFlags(id),
      choice: { kind: 'preset', id },
      editingFormatId: null,
      formatChoices: state.formatChoices + 1
    })),

  /** Uses a saved format's flags; saving again changes it (T-45). */
  chooseFormat: (format: TranscriptionFormat): void =>
    exportStore.set((state) => ({
      flags: flagsOf(format),
      choice: { kind: 'saved', id: format.id },
      editingFormatId: format.id,
      formatChoices: state.formatChoices + 1
    })),

  /** One setting changed by hand: the format is custom now (T-44). */
  setFlag: <K extends keyof TranscriptFormatFlags>(key: K, value: TranscriptFormatFlags[K]): void =>
    exportStore.set((state) => ({
      flags: { ...state.flags, [key]: value },
      choice: { kind: 'custom' }
    })),

  /** After a saved format was deleted: the default preset if it was the one in use. */
  formatDeleted: (id: string): void => {
    const state = exportStore.get()
    if (state.choice.kind === 'saved' && state.choice.id === id) {
      exportActions.choosePreset(TRANSCRIPT_DEFAULT_PRESET)
    } else if (state.editingFormatId === id) exportStore.set({ editingFormatId: null })
  },

  /** Back to the defaults: the next user does not work on the last one's saved format. */
  reset: (): void => exportStore.set(INITIAL),

  /**
   * Shows or hides one speaker of one transcript in the transcript export (T-43). Like kiChat's
   * speaker chips this makes the format custom; the saved format being changed stays the same.
   */
  toggleSpeaker: (transcriptId: string, speaker: string): void =>
    exportStore.set((state) => {
      const current = state.visibleSpeakers[transcriptId] ?? {}
      return {
        visibleSpeakers: {
          ...state.visibleSpeakers,
          [transcriptId]: { ...current, [speaker]: current[speaker] === false }
        },
        choice: { kind: 'custom' }
      }
    })
}

onSignOut(() => exportActions.reset())
