import type { MicrophoneChoice } from './devices'

/**
 * The sources a take mixes besides the main microphone, which the microphone select chooses:
 * more microphones, and tabs, windows or screens. They can be added and removed before and while
 * recording. Microphones stay listed for the next take and open with it; a tab, window or screen
 * is shared once, held from then on and let go when its take ends.
 */

/** The main microphone's id in the mix. */
export const MAIN_SOURCE_ID = 'main'

export type SourceKind = 'microphone' | 'display'

export interface RecordingSource {
  id: string
  kind: SourceKind
  /** A microphone's device; `null` for a tab, window or screen. */
  deviceId: string | null
  /** The device's or the surface's name, shown and announced. */
  label: string
}

/** `ended`: the source went away by itself (sharing stopped, tab closed, device unplugged). */
export type SourceChange = 'added' | 'removed' | 'ended'

export interface SourceAnnouncement {
  change: SourceChange
  label: string
  /** Counts up, so the same change twice is still a new announcement. */
  serial: number
}

export interface SourcesState {
  list: readonly RecordingSource[]
  /** The last change, announced politely; an ended source is shown until dismissed. */
  announcement: SourceAnnouncement | null
}

export type SourcesAction =
  | { type: 'add'; source: RecordingSource }
  | { type: 'remove'; id: string }
  | { type: 'ended'; id: string }
  /** The main microphone ended; it is not in the list. */
  | { type: 'mainEnded'; label: string }
  /** The main microphone is now this device: it is no added source any more. */
  | { type: 'mainSelected'; deviceId: string }
  /** A take ended: its tabs, windows and screens are let go. */
  | { type: 'takeEnded' }
  | { type: 'dismiss' }

export const INITIAL_SOURCES: SourcesState = { list: [], announcement: null }

function announce(state: SourcesState, change: SourceChange, label: string): SourceAnnouncement {
  return { change, label, serial: (state.announcement?.serial ?? 0) + 1 }
}

export function sourcesReducer(state: SourcesState, action: SourcesAction): SourcesState {
  switch (action.type) {
    case 'add':
      if (state.list.some((source) => source.id === action.source.id)) return state
      return {
        list: [...state.list, action.source],
        announcement: announce(state, 'added', action.source.label)
      }
    case 'remove':
    case 'ended': {
      const source = state.list.find((entry) => entry.id === action.id)
      if (!source) return state
      return {
        list: state.list.filter((entry) => entry !== source),
        announcement: announce(state, action.type === 'ended' ? 'ended' : 'removed', source.label)
      }
    }
    case 'mainEnded':
      return { ...state, announcement: announce(state, 'ended', action.label) }
    case 'mainSelected': {
      const list = state.list.filter((source) => source.deviceId !== action.deviceId)
      return list.length === state.list.length ? state : { ...state, list }
    }
    case 'takeEnded': {
      const list = state.list.filter((source) => source.kind !== 'display')
      return list.length === state.list.length ? state : { ...state, list }
    }
    case 'dismiss':
      return state.announcement ? { ...state, announcement: null } : state
  }
}

/** The input devices that can be added: neither the main microphone nor added already. */
export function addableMicrophones(
  choices: readonly MicrophoneChoice[],
  main: string,
  list: readonly RecordingSource[]
): MicrophoneChoice[] {
  const used = new Set([main, ...list.map((source) => source.deviceId)])
  return choices.filter((choice) => !used.has(choice.deviceId))
}

/** Added microphones whose device is no longer among `choices`, e.g. unplugged. */
export function goneMicrophones(
  list: readonly RecordingSource[],
  choices: readonly MicrophoneChoice[]
): RecordingSource[] {
  const present = new Set(choices.map((choice) => choice.deviceId))
  return list.filter(
    (source) => source.kind === 'microphone' && !present.has(source.deviceId ?? '')
  )
}
