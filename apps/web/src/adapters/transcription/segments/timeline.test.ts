import { describe, expect, it } from 'vitest'
import type { TranscriptionSourceFile } from '@justcampus/shared'
import { playbackStep } from './timeline'

const source = (startTime: number, endTime: number): TranscriptionSourceFile => ({
  name: `${startTime}.wav`,
  size: 1,
  duration: endTime - startTime,
  startTime,
  endTime,
  jobId: null
})

// The reference fixture: 11.24 s of audio, of which the transcript covers 10.72 s.
const sources = [source(0, 10.72), source(10.72, 20)]

describe('playbackStep', () => {
  it('plays on inside the saved range of a source', () => {
    expect(playbackStep(sources, 0, 5, null, 4.9)).toEqual({ kind: 'play', time: 5 })
    expect(playbackStep(sources, 1, 2, null, 12.6)).toEqual({ kind: 'play', time: 12.72 })
  })

  it('hands over at the saved end, not at the end of the audio, and never shows a later time', () => {
    expect(playbackStep(sources, 0, 10.8, null, 10.7)).toEqual({
      kind: 'next',
      index: 1,
      local: 0,
      time: 10.72
    })
    expect(playbackStep(sources, 1, 9.5, null, 19.9)).toEqual({
      kind: 'stop',
      time: 20,
      last: true
    })
  })

  it('carries the end of a block across sources and stops when it is crossed', () => {
    // A block from 8 to 14 s: the first source hands over, the second stops at 14.
    expect(playbackStep(sources, 0, 10.75, 14, 10.7)).toMatchObject({ kind: 'next', index: 1 })
    expect(playbackStep(sources, 1, 3, 14, 13.6)).toEqual({ kind: 'play', time: 13.72 })
    expect(playbackStep(sources, 1, 3.3, 14, 13.72)).toEqual({
      kind: 'stop',
      time: 14,
      last: false
    })
    // Seeking past the end does not stop playback.
    expect(playbackStep(sources, 1, 6, 14, 18)).toEqual({ kind: 'play', time: 16.72 })
  })

  it('takes a source without a usable range as it is', () => {
    expect(playbackStep([source(0, 0)], 0, 30, null, 29)).toEqual({ kind: 'play', time: 30 })
    expect(playbackStep([], 0, 3, null, null)).toEqual({ kind: 'play', time: 3 })
  })
})
