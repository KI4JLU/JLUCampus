import { describe, expect, it, vi } from 'vitest'
import { PlayRequests, scrubPlayback, startSample, type SampleMedia } from './sample-audio'

/** An `<audio>` stand-in whose metadata arrives when the test says so. */
function media(): SampleMedia & { loadMetadata: () => void; play: ReturnType<typeof vi.fn> } {
  const listeners = new Set<() => void>()
  return {
    src: '',
    currentTime: 0,
    error: null,
    play: vi.fn(async () => undefined),
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
    loadMetadata: () => {
      for (const listener of [...listeners]) listener()
    }
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('sample playback (T-19, T-21)', () => {
  it('plays the window once the URL and the metadata are there', async () => {
    const audio = media()
    const requests = new PlayRequests()
    const onStart = vi.fn()
    const started = startSample(audio, {
      resolve: async () => 'blob:a',
      loaded: { current: null },
      start: 2,
      current: requests.begin(),
      onStart
    })
    await vi.waitFor(() => expect(audio.src).toBe('blob:a'))
    audio.loadMetadata()
    expect(await started).toBe('playing')
    expect(audio.currentTime).toBe(2)
    expect(onStart).toHaveBeenCalledOnce()
    expect(audio.play).toHaveBeenCalledOnce()
  })

  it('does not start after Stop while the URL was still loading', async () => {
    const audio = media()
    const requests = new PlayRequests()
    const url = deferred<string | null>()
    const onStart = vi.fn()
    const started = startSample(audio, {
      resolve: () => url.promise,
      loaded: { current: null },
      start: 0,
      current: requests.begin(),
      onStart
    })
    requests.cancel()
    url.resolve('blob:a')
    expect(await started).toBe('stale')
    expect(audio.play).not.toHaveBeenCalled()
    expect(onStart).not.toHaveBeenCalled()
  })

  it('does not start after Stop or a new analysis while the metadata was loading', async () => {
    const audio = media()
    const requests = new PlayRequests()
    const started = startSample(audio, {
      resolve: async () => 'https://storage.test/a',
      loaded: { current: null },
      start: 0,
      current: requests.begin(),
      onStart: () => undefined
    })
    await vi.waitFor(() => expect(audio.src).toBe('https://storage.test/a'))
    requests.cancel()
    audio.loadMetadata()
    expect(await started).toBe('stale')
    expect(audio.play).not.toHaveBeenCalled()
  })

  it('lets only the newest of two pending samples play', async () => {
    const audio = media()
    const requests = new PlayRequests()
    const first = deferred<string | null>()
    const loaded = { current: 'blob:a' }
    const older = startSample(audio, {
      resolve: () => first.promise,
      loaded,
      start: 1,
      current: requests.begin(),
      onStart: () => undefined
    })
    const newer = startSample(audio, {
      resolve: async () => 'blob:a',
      loaded,
      start: 7,
      current: requests.begin(),
      onStart: () => undefined
    })
    expect(await newer).toBe('playing')
    first.resolve('blob:a')
    expect(await older).toBe('stale')
    expect(audio.play).toHaveBeenCalledOnce()
    expect(audio.currentTime).toBe(7)
  })

  it('counts a play cut short by Stop as no failure', async () => {
    const audio = media()
    const requests = new PlayRequests()
    audio.play.mockImplementation(async () => {
      requests.cancel()
      throw new DOMException('interrupted', 'AbortError')
    })
    const outcome = await startSample(audio, {
      resolve: async () => 'blob:a',
      loaded: { current: 'blob:a' },
      start: 0,
      current: requests.begin(),
      onStart: () => undefined
    })
    expect(outcome).toBe('stale')
  })
})

describe('scrubbing the sample (T-19)', () => {
  it('moves the sound along while it plays', () => {
    expect(scrubPlayback({ time: 4, playing: true, startedPlaying: true, duration: 10 })).toBe(
      'seek'
    )
  })

  it('starts the sound again when it stopped at an end during a scrub begun playing', () => {
    expect(scrubPlayback({ time: 4, playing: false, startedPlaying: true, duration: 10 })).toBe(
      'play'
    )
    expect(scrubPlayback({ time: 4, playing: false, startedPlaying: true, duration: null })).toBe(
      'play'
    )
  })

  it('stays silent at the end of the file', () => {
    expect(scrubPlayback({ time: 10, playing: false, startedPlaying: true, duration: 10 })).toBe(
      'none'
    )
  })

  it('leaves a scrub begun silent silent until it is let go', () => {
    expect(scrubPlayback({ time: 4, playing: false, startedPlaying: false, duration: 10 })).toBe(
      'none'
    )
  })
})
