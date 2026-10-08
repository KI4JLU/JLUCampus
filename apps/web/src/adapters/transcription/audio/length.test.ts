import { describe, expect, it } from 'vitest'
import { nextLoad, sourceLength, type MediaLength, type SourceLoad } from './length'

/** A step of a player: its source now, and the metadata reported (`'reported'`) or not. */
type Step = [source: Blob | string | null, metadata?: 'reported']

/**
 * The lengths a player knows through these steps as `WaveformPlayer` tracks them: a new load per
 * source change, the media's `duration` once reported in the current load, `fallback` as the time
 * line's length of each file.
 */
function lengths(
  steps: readonly Step[],
  duration: number,
  fallback: (source: Blob | string) => number
): number[] {
  let load: SourceLoad = { source: null, id: 0 }
  let media: MediaLength | null = null
  return steps.map(([source, metadata]) => {
    load = nextLoad(load, source)
    if (metadata) media = { load: load.id, duration }
    return sourceLength(load, media, undefined, source ? fallback(source) : undefined)
  })
}

/**
 * Where the player calls `onDuration`, as its effect does: whenever the length changes to a known
 * one. The global player applies a waiting seek at the first of them.
 */
function reports(known: readonly number[]): number[] {
  return known.flatMap((length, index) =>
    length > 0 && length !== (known[index - 1] ?? 0) ? [index] : []
  )
}

const first = 'https://campus.example/api/modules/transcription/jobs/a/audio/file'
const second = 'https://campus.example/api/modules/transcription/jobs/b/audio/file'
/** The time line's length of each file: 30 s and 45 s. */
const saved = (source: Blob | string): number => (source === first ? 30 : 45)

describe('sourceLength', () => {
  it('takes the media’s length, else the waveform’s, else the time line’s for a recording', () => {
    const load: SourceLoad = { source: new Blob(['x']), id: 1 }
    expect(sourceLength(load, { load: 1, duration: 12 }, 11, 10)).toBe(12)
    expect(sourceLength(load, { load: 1, duration: Infinity }, 11, 10)).toBe(11)
    expect(sourceLength(load, { load: 1, duration: Infinity }, undefined, 10)).toBe(10)
    expect(sourceLength(load, { load: 1, duration: NaN }, undefined, 10)).toBe(10)
    // Media with a length of its own does not borrow the time line's.
    expect(sourceLength(load, { load: 1, duration: 0 }, undefined, 10)).toBe(0)
  })

  it('knows nothing before the media of this load reported, a waveform neither', () => {
    const load: SourceLoad = { source: new Blob(['x']), id: 2 }
    expect(sourceLength(load, null, 11, 10)).toBe(0)
    expect(sourceLength(load, { load: 1, duration: 12 }, 11, 10)).toBe(0)
    expect(sourceLength({ source: null, id: 2 }, { load: 2, duration: 12 }, 11, 10)).toBe(0)
  })

  it('keeps a seek into the next file until its delayed URL loaded, after a recording (T-24)', () => {
    const known = lengths(
      [
        // The first file is a recording: no length of its own.
        [first],
        [first, 'reported'],
        // A seek into the second file: its URL is still being fetched.
        [null],
        // The URL arrived; the audio element loads it.
        [second],
        [second, 'reported']
      ],
      Infinity,
      saved
    )
    expect(known).toEqual([0, 30, 0, 0, 45])
    expect(reports(known)).toEqual([1, 4])
  })

  it('keeps a seek back into a file loaded before until it loaded again (T-24)', () => {
    const known = lengths(
      [
        [first],
        [first, 'reported'],
        // A seek into the second file, whose URL is pending, then back into the first, whose
        // URL is cached: the element loads it anew.
        [null],
        [first],
        [first, 'reported']
      ],
      Infinity,
      saved
    )
    expect(known).toEqual([0, 30, 0, 0, 30])
    expect(reports(known)).toEqual([1, 4])
  })
})

describe('nextLoad', () => {
  it('starts a load per change of the source, clearing it too, and keeps it otherwise', () => {
    const start: SourceLoad = { source: first, id: 1 }
    expect(nextLoad(start, first)).toBe(start)
    const cleared = nextLoad(start, null)
    expect(cleared).toEqual({ source: null, id: 2 })
    expect(nextLoad(cleared, first)).toEqual({ source: first, id: 3 })
  })
})
