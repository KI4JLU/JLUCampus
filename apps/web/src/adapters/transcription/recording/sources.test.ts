import { describe, expect, it } from 'vitest'
import { DEFAULT_DEVICE_ID, type MicrophoneChoice } from './devices'
import {
  addableMicrophones,
  canRemoveSource,
  goneMicrophones,
  INITIAL_SOURCES,
  mainSuccessor,
  sourcesReducer,
  type RecordingSource,
  type SourcesAction,
  type SourcesState
} from './sources'

const headset: RecordingSource = {
  id: 's1',
  kind: 'microphone',
  deviceId: 'headset',
  label: 'Headset'
}
const tab: RecordingSource = { id: 's2', kind: 'display', deviceId: null, label: 'Seminar' }

function run(actions: SourcesAction[], state = INITIAL_SOURCES): SourcesState {
  return actions.reduce(sourcesReducer, state)
}

const choice = (deviceId: string, number: number): MicrophoneChoice => ({
  deviceId,
  label: deviceId,
  number
})

describe('sourcesReducer', () => {
  it('adds and removes sources, announcing each change', () => {
    const added = run([
      { type: 'add', source: headset },
      { type: 'add', source: tab }
    ])
    expect(added.list).toEqual([headset, tab])
    expect(added.announcement).toEqual({ change: 'added', label: 'Seminar', serial: 2 })
    // The same source twice stays one.
    expect(sourcesReducer(added, { type: 'add', source: tab })).toBe(added)

    const removed = sourcesReducer(added, { type: 'remove', id: tab.id })
    expect(removed.list).toEqual([headset])
    expect(removed.announcement).toEqual({ change: 'removed', label: 'Seminar', serial: 3 })
    expect(sourcesReducer(removed, { type: 'remove', id: tab.id })).toBe(removed)
  })

  it('tells a source that ended by itself, also the main microphone', () => {
    const ended = run([
      { type: 'add', source: tab },
      { type: 'ended', id: tab.id }
    ])
    expect(ended).toEqual({
      list: [],
      announcement: { change: 'ended', label: 'Seminar', serial: 2 }
    })
    const main = sourcesReducer(ended, { type: 'mainChanged', change: 'ended', label: 'Laptop' })
    expect(main.announcement).toEqual({ change: 'ended', label: 'Laptop', serial: 3 })
    expect(sourcesReducer(main, { type: 'dismiss' }).announcement).toBeNull()
  })

  it('announces the main microphone added or removed, leaving the list alone', () => {
    const state = run([{ type: 'add', source: tab }])
    const removed = sourcesReducer(state, { type: 'mainChanged', change: 'removed', label: 'USB' })
    expect(removed).toEqual({
      list: [tab],
      announcement: { change: 'removed', label: 'USB', serial: 2 }
    })
    const added = sourcesReducer(removed, { type: 'mainChanged', change: 'added', label: 'USB' })
    expect(added.announcement).toEqual({ change: 'added', label: 'USB', serial: 3 })
  })

  it('lets go of tabs, windows and screens when a take ends, keeping microphones', () => {
    const state = run([
      { type: 'add', source: headset },
      { type: 'add', source: tab },
      { type: 'takeEnded' }
    ])
    expect(state.list).toEqual([headset])
    expect(sourcesReducer(state, { type: 'takeEnded' })).toBe(state)
  })

  it('drops an added microphone that becomes the main one', () => {
    const state = run([
      { type: 'add', source: headset },
      { type: 'add', source: tab }
    ])
    expect(sourcesReducer(state, { type: 'mainSelected', deviceId: 'headset' }).list).toEqual([tab])
    expect(sourcesReducer(state, { type: 'mainSelected', deviceId: 'other' })).toBe(state)
  })
})

describe('addableMicrophones', () => {
  const choices = [choice('laptop', 1), choice('headset', 2), choice('usb', 3)]

  it('offers the default input first, then the devices not in use', () => {
    expect(addableMicrophones(choices, 'laptop', [headset, tab])).toEqual([
      DEFAULT_DEVICE_ID,
      'usb'
    ])
    expect(addableMicrophones(choices, DEFAULT_DEVICE_ID, [])).toEqual(['laptop', 'headset', 'usb'])
  })

  it('offers every microphone without a main one', () => {
    expect(addableMicrophones(choices, null, [tab])).toEqual([
      DEFAULT_DEVICE_ID,
      'laptop',
      'headset',
      'usb'
    ])
  })

  it('leaves out the default input once it is added', () => {
    const fallback: RecordingSource = { ...headset, id: 's3', deviceId: DEFAULT_DEVICE_ID }
    expect(addableMicrophones(choices, 'laptop', [fallback])).toEqual(['headset', 'usb'])
  })
})

describe('canRemoveSource', () => {
  it('keeps the last source, be it the main microphone or another', () => {
    expect(canRemoveSource(DEFAULT_DEVICE_ID, [])).toBe(false)
    expect(canRemoveSource(null, [tab])).toBe(false)
    expect(canRemoveSource(DEFAULT_DEVICE_ID, [tab])).toBe(true)
    expect(canRemoveSource(null, [headset, tab])).toBe(true)
  })
})

describe('mainSuccessor', () => {
  it('hands over to the first added microphone, else to none', () => {
    expect(mainSuccessor([tab, headset])).toBe('headset')
    expect(mainSuccessor([tab])).toBeNull()
    expect(mainSuccessor([])).toBeNull()
  })
})

describe('goneMicrophones', () => {
  it('finds microphones whose device disappeared, never a shared surface', () => {
    expect(goneMicrophones([headset, tab], [choice('laptop', 1)])).toEqual([headset])
    expect(goneMicrophones([headset, tab], [choice('headset', 1)])).toEqual([])
  })

  it('never counts the default input as gone', () => {
    const fallback: RecordingSource = { ...headset, deviceId: DEFAULT_DEVICE_ID }
    expect(goneMicrophones([fallback], [])).toEqual([])
  })
})
