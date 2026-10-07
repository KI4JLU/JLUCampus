import { describe, expect, it } from 'vitest'
import { sourceLength, type MediaLength } from './length'

type PlayerState = Parameters<typeof sourceLength>

/**
 * The states in which a player calls `onDuration`, as its effect does: whenever the length
 * changes to a known one. The global player applies a waiting seek at the first of them.
 */
function reports(states: readonly PlayerState[]): number[] {
  const at: number[] = []
  let last = 0
  states.forEach((state, index) => {
    const length = sourceLength(...state)
    if (length > 0 && length !== last) at.push(index)
    last = length
  })
  return at
}

describe('sourceLength', () => {
  it('takes the media’s length, else the waveform’s, else the time line’s for a recording', () => {
    const blob = new Blob(['x'])
    expect(sourceLength(blob, { source: blob, duration: 12 }, 11, 10)).toBe(12)
    expect(sourceLength(blob, { source: blob, duration: Infinity }, 11, 10)).toBe(11)
    expect(sourceLength(blob, { source: blob, duration: Infinity }, undefined, 10)).toBe(10)
    expect(sourceLength(blob, { source: blob, duration: NaN }, undefined, 10)).toBe(10)
    // Media with a length of its own does not borrow the time line's.
    expect(sourceLength(blob, { source: blob, duration: 0 }, undefined, 10)).toBe(0)
  })

  it('knows nothing before the media of this source reported, a waveform neither', () => {
    const blob = new Blob(['x'])
    expect(sourceLength(blob, null, 11, 10)).toBe(0)
    expect(sourceLength(null, null, 11, 10)).toBe(0)
  })

  it('keeps a seek into the next file until its delayed URL loaded, after a recording (T-24)', () => {
    const first = 'https://s3.example/a.webm?X-Amz-Signature=a'
    const second = 'https://s3.example/b.webm?X-Amz-Signature=b'
    // The first file is a recording: no length of its own, 30 s on the time line.
    const recorded: MediaLength = { source: first, duration: Infinity }
    const states: PlayerState[] = [
      [first, null, undefined, 30],
      [first, recorded, undefined, 30],
      // A seek into the second file (45 s): its URL is still being fetched.
      [null, recorded, undefined, 45],
      // The URL arrived; the audio element loads it.
      [second, recorded, undefined, 45],
      // Its metadata: a recording again.
      [second, { source: second, duration: Infinity }, undefined, 45]
    ]
    expect(states.map((state) => sourceLength(...state))).toEqual([0, 30, 0, 0, 45])
    expect(reports(states)).toEqual([1, 4])
  })
})
