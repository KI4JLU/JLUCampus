import { describe, expect, it, vi } from 'vitest'
import type { LocalRecorder } from './local-recorder'
import {
  keepsTracks,
  TakeTracks,
  trackFilename,
  trackFiles,
  trackOffset,
  type FinishedTrack,
  type TrackJournal,
  type TrackRecording,
  type TrackStart
} from './tracks'

const stream = (id: string): MediaStream => ({ id }) as unknown as MediaStream

/** A recorder that records `text`, and what happened to it. */
function fakeRecording(text: string, events: string[]): TrackRecording {
  const recorder: LocalRecorder = {
    mimeType: Promise.resolve('audio/webm'),
    stop: vi.fn(() => {
      events.push(`stop ${text}`)
      return Promise.resolve(new Blob([text], { type: 'audio/webm' }))
    }),
    discard: vi.fn(() => {
      events.push(`discard ${text}`)
      return Promise.resolve()
    })
  }
  const journal: TrackJournal = {
    close: vi.fn((endedAt: number) => {
      events.push(`close ${text} at ${endedAt}`)
      return Promise.resolve()
    })
  }
  return { recorder, journal }
}

/** Tracks of a take started at 0 on a clock the test moves, recording each stream's id. */
function tracksOnClock(): {
  tracks: TakeTracks
  clock: { now: number }
  events: string[]
  starts: TrackStart[]
} {
  const clock = { now: 0 }
  const events: string[] = []
  const starts: TrackStart[] = []
  let ids = 0
  const tracks = new TakeTracks(
    0,
    (source, start) => {
      starts.push(start)
      return fakeRecording(source.id, events)
    },
    () => clock.now,
    () => `t${++ids}`
  )
  return { tracks, clock, events, starts }
}

describe('trackOffset', () => {
  it('counts seconds from the take’s start, never before it', () => {
    expect(trackOffset(10_000, 22_500)).toBe(12.5)
    expect(trackOffset(10_000, 9_000)).toBe(0)
  })
})

describe('keepsTracks', () => {
  it('keeps tracks only of sources that sounded at the same time', () => {
    // One source: the mix is it.
    expect(keepsTracks([{ offset: 0, duration: 60 }])).toBe(false)
    expect(keepsTracks([])).toBe(false)
    // A microphone swapped for another: one after the other.
    expect(
      keepsTracks([
        { offset: 0, duration: 30 },
        { offset: 30, duration: 30 }
      ])
    ).toBe(false)
    // A tab shared for a while beside the microphone.
    expect(
      keepsTracks([
        { offset: 0, duration: 60 },
        { offset: 12, duration: 5 }
      ])
    ).toBe(true)
    expect(
      keepsTracks([
        { offset: 40, duration: 10 },
        { offset: 0, duration: 30 },
        { offset: 29, duration: 2 }
      ])
    ).toBe(true)
  })
})

describe('trackFilename', () => {
  it('names a track after its take, its number and its source', () => {
    expect(trackFilename('max-20261008-101500.webm', 2, 'iPhone-Mikrofon')).toBe(
      'max-20261008-101500-2-iphone-mikrofon.webm'
    )
    expect(trackFilename('max-20261008-101500.m4a', 1, 'Über „Tab“: Vorlesung / Teil 1')).toBe(
      'max-20261008-101500-1-uber-tab-vorlesung-teil-1.m4a'
    )
  })

  it('keeps it short, and falls back to the number alone', () => {
    const long = trackFilename('a.webm', 3, 'x'.repeat(30) + ' ' + 'y'.repeat(30))
    expect(long).toBe(`a-3-${'x'.repeat(30)}-${'y'.repeat(9)}.webm`)
    expect(trackFilename('a.webm', 3, '🎤 ')).toBe('a-3.webm')
    expect(trackFilename('noextension', 1, 'Tab')).toBe('noextension-1-tab')
  })
})

describe('trackFiles', () => {
  const track = (id: string, offset: number, duration: number, label = id): FinishedTrack => ({
    id,
    label,
    kind: 'microphone',
    offset,
    duration,
    blob: new Blob([id])
  })

  it('numbers the tracks by start and names their files after the take', async () => {
    const files = trackFiles('max-1.webm', 'audio/webm', [
      track('tab', 5, 10, 'Seminar'),
      track('mic', 0, 60, 'Headset')
    ])
    expect(files?.map((entry) => [entry.id, entry.file.name, entry.file.type])).toEqual([
      ['mic', 'max-1-1-headset.webm', 'audio/webm'],
      ['tab', 'max-1-2-seminar.webm', 'audio/webm']
    ])
    expect(await files![1]!.file.text()).toBe('tab')
    expect(files![1]).toMatchObject({
      label: 'Seminar',
      kind: 'microphone',
      offset: 5,
      duration: 10
    })
  })

  it('keeps none for a take of one source at a time', () => {
    expect(trackFiles('max-1.webm', 'audio/webm', [track('mic', 0, 60)])).toBeUndefined()
    expect(
      trackFiles('max-1.webm', 'audio/webm', [track('a', 0, 30), track('b', 30, 30)])
    ).toBeUndefined()
  })
})

describe('TakeTracks', () => {
  it('records each stream once, from its start to its stop', async () => {
    const { tracks, clock, events, starts } = tracksOnClock()
    const mic = stream('mic')
    const tab = stream('tab')
    tracks.start(mic, 'Headset', 'microphone')
    clock.now = 12_000
    tracks.start(tab, 'Seminar', 'display')
    // A stream that moves from an added microphone to the main one is still one track.
    tracks.start(mic, 'Headset', 'microphone')
    expect(starts.map((start) => [start.id, start.startedAt])).toEqual([
      ['t1', 0],
      ['t2', 12_000]
    ])

    clock.now = 20_000
    tracks.stop(tab)
    // The recorder is told to stop at once, before the caller releases the stream.
    expect(events).toEqual(['stop tab'])
    clock.now = 60_000
    const finished = await tracks.finish()
    expect(
      finished.map(({ id, label, kind, offset, duration }) => [id, label, kind, offset, duration])
    ).toEqual([
      ['t1', 'Headset', 'microphone', 0, 60],
      ['t2', 'Seminar', 'display', 12, 8]
    ])
    // Each backup closes after its recorder's last chunk, with when the track stopped.
    expect(events.indexOf('close tab at 20000')).toBeGreaterThan(events.indexOf('stop tab'))
    expect(events.indexOf('close mic at 60000')).toBeGreaterThan(events.indexOf('stop mic'))
  })

  it('starts a new track for a stream swapped in, and stops none twice', async () => {
    const { tracks, clock } = tracksOnClock()
    const first = stream('first')
    const second = stream('second')
    tracks.start(first, 'Laptop', 'microphone')
    clock.now = 30_000
    tracks.stop(first)
    tracks.stop(first)
    tracks.start(second, 'USB', 'microphone')
    clock.now = 50_000
    const finished = await tracks.finish()
    expect(finished.map((track) => [track.label, track.offset, track.duration])).toEqual([
      ['Laptop', 0, 30],
      ['USB', 30, 20]
    ])
    expect(keepsTracks(finished)).toBe(false)
  })

  it('goes on without a track whose recorder cannot start, or that recorded nothing', async () => {
    const events: string[] = []
    const tracks = new TakeTracks(0, (source) => {
      if (source.id === 'broken') throw new Error('NotSupportedError')
      return fakeRecording(source.id === 'silent' ? '' : source.id, events)
    })
    tracks.start(stream('broken'), 'Broken', 'microphone')
    tracks.start(stream('silent'), 'Silent', 'display')
    tracks.start(stream('mic'), 'Mic', 'microphone')
    expect((await tracks.finish()).map((track) => track.label)).toEqual(['Mic'])
  })

  it('starts no track once the take ends', async () => {
    const { tracks, starts } = tracksOnClock()
    tracks.start(stream('mic'), 'Mic', 'microphone')
    const finishing = tracks.finish()
    // A microphone that opened while the take was stopping.
    tracks.start(stream('late'), 'Late', 'microphone')
    expect((await finishing).map((track) => track.label)).toEqual(['Mic'])
    expect(starts).toHaveLength(1)
  })

  it('drops the running tracks when the page goes, closing their backups', async () => {
    const { tracks, events } = tracksOnClock()
    const tab = stream('tab')
    tracks.start(stream('mic'), 'Mic', 'microphone')
    tracks.start(tab, 'Tab', 'display')
    tracks.stop(tab)
    await tracks.discard()
    expect(events).toEqual(['stop tab', 'discard mic', 'close tab at 0', 'close mic at 0'])
  })
})
