import { useCallback, useEffect, useRef, useState } from 'react'
import { mediaUrlExpiresSoon, useJobAudioUrl } from '../api'
import { playExclusively } from '../audio'
import type { QueueFile } from '../upload/queue'

/**
 * The audio the mapping dialog plays its samples from: the local file, or for a restored job a
 * URL fetched anew when it expires within five minutes (T-21). All samples are windows of
 * the same file, as in kiChat.
 */
export function useSampleSource(file: QueueFile): {
  /** A URL to play now, fresh; `null` when there is none. */
  resolve: () => Promise<string | null>
} {
  const local = file.file
  // Made when first played, and let go with the dialog.
  const objectUrl = useRef<{ blob: Blob; url: string } | null>(null)
  useEffect(
    () => () => {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current.url)
      objectUrl.current = null
    },
    [local]
  )

  const remote = useJobAudioUrl(local ? null : file.jobId)
  const { data, refetch } = remote

  // Opening the dialog renews a URL that is about to expire, as kiChat's `refreshSpeakerAudioUrls`.
  useEffect(() => {
    if (data && mediaUrlExpiresSoon(data)) void refetch()
  }, [data, refetch])

  const resolve = useCallback(async (): Promise<string | null> => {
    if (local) {
      if (objectUrl.current?.blob !== local) {
        if (objectUrl.current) URL.revokeObjectURL(objectUrl.current.url)
        objectUrl.current = { blob: local, url: URL.createObjectURL(local) }
      }
      return objectUrl.current.url
    }
    if (data && !mediaUrlExpiresSoon(data)) return data.url
    const fresh = await refetch()
    return fresh.data?.url ?? null
  }, [data, local, refetch])

  return { resolve }
}

/**
 * What one move of a scrub does to the sound: it follows the pointer while it plays. A scrub begun
 * playing whose sound stopped at an end meanwhile starts it again from the pointer, unless that is
 * the file's end, where it would stop at once.
 */
export function scrubPlayback(move: {
  time: number
  playing: boolean
  startedPlaying: boolean
  duration: number | null
}): 'seek' | 'play' | 'none' {
  if (move.playing) return 'seek'
  if (!move.startedPlaying) return 'none'
  return move.duration === null || move.time < move.duration ? 'play' : 'none'
}

/** What plays: a sample's key and where it stops. */
interface Playing {
  key: string
  end: number
}

/**
 * Who started the sound: a sample's chip (kiChat's preview, which any other click stops) or the
 * sample editor (kiChat's editor player, which plays on).
 */
export type PlayOrigin = 'chip' | 'editor'

export interface SamplePlayer {
  /** The key of the sample playing, if any. */
  playing: string | null
  /** The playhead in seconds of the file. */
  time: number
  /** The audio's length once known. */
  duration: number | null
  /** Whether the audio could not be loaded. */
  failed: boolean
  /**
   * Plays from `start` and stops at `end` (`Infinity`: at the end of the file); `origin` defaults
   * to the editor.
   */
  play: (key: string, start: number, end: number, origin?: PlayOrigin) => Promise<void>
  stop: () => void
  /**
   * Moves the playhead of the sound playing to `time`, which now stops at `end`: the sample
   * editor's scrub. Does nothing while none plays.
   */
  seek: (time: number, end: number) => void
  /** Plays the window, or stops it when it is the one playing (kiChat's chips). */
  toggle: (key: string, start: number, end: number) => void
  /** The key of a chip's preview playing or starting, else `null`; read at event time. */
  preview: () => string | null
  /** The hidden `<audio>` element to render. */
  element: React.JSX.Element
}

/** The part of `<audio>` a sample's start needs. */
export interface SampleMedia {
  src: string
  currentTime: number
  readonly error: unknown
  play: () => Promise<void>
  addEventListener: (type: 'loadedmetadata' | 'error', listener: () => void) => void
  removeEventListener: (type: 'loadedmetadata' | 'error', listener: () => void) => void
}

/**
 * Play requests in order: each begins a new one, and `cancel` (stop, a new analysis, closing the
 * dialog) ends the one pending, so a request still waiting for its URL or the audio's metadata
 * does not start after it (T-19, T-21).
 */
export class PlayRequests {
  private generation = 0

  /** A new request; the function tells whether it is still the current one. */
  begin(): () => boolean {
    const mine = ++this.generation
    return () => mine === this.generation
  }

  cancel(): void {
    this.generation++
  }
}

/**
 * Loads the audio if its URL changed and plays from `start`, checking after every wait that the
 * request is still current. `onStart` runs right before the sound starts.
 */
export async function startSample(
  audio: SampleMedia,
  request: {
    resolve: () => Promise<string | null>
    /** The URL the element holds already. */
    loaded: { current: string | null }
    start: number
    current: () => boolean
    onStart: () => void
  }
): Promise<'stale' | 'noUrl' | 'playing' | 'failed'> {
  const url = await request.resolve()
  if (!request.current()) return 'stale'
  if (!url) return 'noUrl'
  if (request.loaded.current !== url) {
    request.loaded.current = url
    audio.src = url
    await new Promise<void>((done) => {
      const finish = (): void => {
        audio.removeEventListener('loadedmetadata', finish)
        audio.removeEventListener('error', finish)
        done()
      }
      audio.addEventListener('loadedmetadata', finish)
      audio.addEventListener('error', finish)
    })
    if (!request.current()) return 'stale'
  }
  audio.currentTime = request.start
  request.onStart()
  try {
    await audio.play()
    return 'playing'
  } catch {
    // A stop during the start rejects the play; that is no failure.
    return request.current() ? 'failed' : 'stale'
  }
}

/** One player for every sample of the dialog, so only one plays at a time (kiChat's preview). */
export function useSamplePlayer(resolve: () => Promise<string | null>): SamplePlayer {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const loaded = useRef<string | null>(null)
  const range = useRef<Playing | null>(null)
  const requests = useRef(new PlayRequests())
  // The latest request, set before it waits for the audio, so a click meanwhile sees it.
  const requested = useRef<{ key: string; origin: PlayOrigin } | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState<number | null>(null)
  const [failed, setFailed] = useState(false)

  const stop = useCallback(() => {
    requests.current.cancel()
    requested.current = null
    range.current = null
    audioRef.current?.pause()
    setPlaying(null)
  }, [])

  const play = useCallback(
    async (
      key: string,
      start: number,
      end: number,
      origin: PlayOrigin = 'editor'
    ): Promise<void> => {
      const audio = audioRef.current
      if (!audio) return
      const current = requests.current.begin()
      requested.current = { key, origin }
      const outcome = await startSample(audio, {
        resolve,
        loaded,
        start,
        current,
        onStart: () => {
          range.current = { key, end }
          setPlaying(key)
          setTime(start)
          setFailed(false)
        }
      })
      if (outcome === 'noUrl') setFailed(true)
      if ((outcome === 'noUrl' || outcome === 'failed') && current()) requested.current = null
      if (outcome === 'failed') {
        range.current = null
        setPlaying(null)
        setFailed(audio.error !== null)
      }
    },
    [resolve]
  )

  const seek = useCallback((time: number, end: number) => {
    const audio = audioRef.current
    const current = range.current
    if (!audio || !current) return
    range.current = { key: current.key, end }
    audio.currentTime = time
    setTime(time)
  }, [])

  const toggle = useCallback(
    (key: string, start: number, end: number) => {
      if (playing === key) stop()
      else void play(key, start, end, 'chip')
    },
    [play, playing, stop]
  )

  const preview = useCallback(
    () => (requested.current?.origin === 'chip' ? requested.current.key : null),
    []
  )

  // While playing, the playhead moves every frame and the window stops at its end.
  useEffect(() => {
    if (playing === null) return
    let frame = 0
    const tick = (): void => {
      const audio = audioRef.current
      if (audio) {
        setTime(audio.currentTime)
        const current = range.current
        if (current && audio.currentTime >= current.end) {
          range.current = null
          requested.current = null
          audio.pause()
        }
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing])

  // Leaving the dialog stops the sound, and a start still pending.
  useEffect(() => {
    const audio = audioRef.current
    const pending = requests.current
    return () => {
      pending.cancel()
      audio?.pause()
    }
  }, [])

  return {
    playing,
    time,
    duration,
    failed,
    play,
    stop,
    seek,
    toggle,
    preview,
    element: (
      <audio
        ref={audioRef}
        hidden
        preload="metadata"
        onPlay={(event) => playExclusively(event.currentTarget)}
        onPause={(event) => {
          // A stop right before a new start: the pause arrives once the new sound plays.
          if (!event.currentTarget.paused) return
          range.current = null
          setPlaying(null)
        }}
        onEnded={() => {
          range.current = null
          requested.current = null
          setPlaying(null)
        }}
        onLoadedMetadata={(event) => {
          const value = event.currentTarget.duration
          if (Number.isFinite(value)) setDuration(value)
        }}
      />
    )
  }
}
