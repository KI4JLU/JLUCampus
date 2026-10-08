import { describe, expect, it } from 'vitest'
import {
  areSourcesLocked,
  INITIAL_RECORDING_STATE,
  isRecordingBusy,
  recordingReducer,
  type RecordingAction,
  type RecordingState
} from './state'

function run(actions: RecordingAction[], state = INITIAL_RECORDING_STATE): RecordingState {
  return actions.reduce(recordingReducer, state)
}

describe('recordingReducer', () => {
  it('goes from idle through recording to ready with a take', () => {
    const requesting = run([{ type: 'request', kind: 'record' }])
    expect(requesting).toMatchObject({ status: 'requesting', kind: 'record', step: 'microphone' })
    const recording = recordingReducer(requesting, { type: 'started', at: 1000 })
    expect(recording).toMatchObject({ status: 'recording', startedAt: 1000, step: null })
    const stopping = recordingReducer(recording, { type: 'stop' })
    expect(stopping.status).toBe('stopping')
    expect(recordingReducer(stopping, { type: 'stopped', takes: 1 })).toMatchObject({
      status: 'ready',
      startedAt: null
    })
  })

  it('connects a live session before recording', () => {
    const state = run([{ type: 'request', kind: 'live' }, { type: 'connect' }])
    expect(state).toMatchObject({ status: 'requesting', kind: 'live', step: 'connecting' })
  })

  it('turns a refused microphone into a recoverable error', () => {
    const failed = run([
      { type: 'request', kind: 'record' },
      { type: 'failed', error: 'Microphone permission denied: Permission denied', takes: 0 }
    ])
    expect(failed).toMatchObject({ status: 'error', error: expect.stringContaining('denied') })
    expect(isRecordingBusy(failed.status)).toBe(false)
    const again = recordingReducer(failed, { type: 'request', kind: 'record' })
    expect(again).toMatchObject({ status: 'requesting', error: null })
  })

  it('ignores a second start while busy', () => {
    const recording = run([
      { type: 'request', kind: 'record' },
      { type: 'started', at: 5 }
    ])
    expect(recordingReducer(recording, { type: 'request', kind: 'live' })).toBe(recording)
  })

  it('stops only a running recording', () => {
    expect(recordingReducer(INITIAL_RECORDING_STATE, { type: 'stop' })).toBe(
      INITIAL_RECORDING_STATE
    )
  })

  it('follows the takes while resting, not while busy or failed', () => {
    const ready = run([{ type: 'takesChanged', takes: 2 }])
    expect(ready.status).toBe('ready')
    expect(recordingReducer(ready, { type: 'takesChanged', takes: 0 }).status).toBe('idle')
    const recording = run([
      { type: 'request', kind: 'record' },
      { type: 'started', at: 5 }
    ])
    expect(recordingReducer(recording, { type: 'takesChanged', takes: 0 })).toBe(recording)
    const failed = run([{ type: 'failed', error: 'x', takes: 1 }])
    expect(recordingReducer(failed, { type: 'takesChanged', takes: 0 })).toBe(failed)
  })

  it('locks the selectors only while requesting, recording or stopping', () => {
    expect(
      ['idle', 'requesting', 'recording', 'stopping', 'ready', 'error'].map((status) =>
        isRecordingBusy(status as RecordingState['status'])
      )
    ).toEqual([false, true, true, true, false, false])
  })

  it('locks the sources while a take starts or ends, and while live transcription runs', () => {
    const recording = (kind: 'record' | 'live'): RecordingState =>
      run([
        { type: 'request', kind },
        { type: 'started', at: 5 }
      ])
    expect(areSourcesLocked(INITIAL_RECORDING_STATE)).toBe(false)
    expect(areSourcesLocked(run([{ type: 'request', kind: 'record' }]))).toBe(true)
    expect(areSourcesLocked(recording('record'))).toBe(false)
    expect(areSourcesLocked(recording('live'))).toBe(true)
    expect(areSourcesLocked(recordingReducer(recording('record'), { type: 'stop' }))).toBe(true)
  })
})
