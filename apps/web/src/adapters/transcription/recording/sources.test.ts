import { describe, expect, it } from 'vitest'
import type { MicrophoneChoice } from './devices'
import {
  addableMicrophones,
  goneMicrophones,
  INITIAL_SOURCES,
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
    const main = sourcesReducer(ended, { type: 'mainEnded', label: 'Laptop' })
    expect(main.announcement).toEqual({ change: 'ended', label: 'Laptop', serial: 3 })
    expect(sourcesReducer(main, { type: 'dismiss' }).announcement).toBeNull()
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
  it('leaves out the main microphone and those added already', () => {
    const choices = [choice('laptop', 1), choice('headset', 2), choice('usb', 3)]
    expect(addableMicrophones(choices, 'laptop', [headset, tab])).toEqual([choice('usb', 3)])
    // The default input names no device.
    expect(addableMicrophones(choices, '', []).length).toBe(3)
  })
})

describe('goneMicrophones', () => {
  it('finds added microphones whose device disappeared, never a shared surface', () => {
    expect(goneMicrophones([headset, tab], [choice('laptop', 1)])).toEqual([headset])
    expect(goneMicrophones([headset, tab], [choice('headset', 1)])).toEqual([])
  })
})
