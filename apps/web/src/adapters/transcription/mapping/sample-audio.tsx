import { useCallback, useEffect, useRef, useState } from 'react'
import { mediaUrlExpiresSoon, useJobAudioUrl } from '../api'
import { playExclusively } from '../audio'
import type { QueueFile } from '../upload/queue'

/**
 * The audio the mapping dialog plays its samples from: the local file, or for a restored job a
 * signed URL fetched anew when it expires within five minutes (T-21). All samples are windows of
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

/** What plays: a sample's key and where it stops. */
interface Playing {
  key: string
  end: number
}

export interface SamplePlayer {
  /** The key of the sample playing, if any. */
  playing: string | null
  /** The playhead in seconds of the file. */
  time: number
  /** The audio's length once known. */
  duration: number | null
  /** Whether the audio could not be loaded. */
  failed: boolean
  /** Plays from `start` and stops at `end` (`Infinity`: at the end of the file). */
  play: (key: string, start: number, end: number) => Promise<void>
  stop: () => void
  /** Plays the window, or stops it when it is the one playing (kiChat's chips). */
  toggle: (key: string, start: number, end: number) => void
  /** The hidden `<audio>` element to render. */
  element: React.JSX.Element
}

/** One player for every sample of the dialog, so only one plays at a time (kiChat's preview). */
export function useSamplePlayer(resolve: () => Promise<string | null>): SamplePlayer {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const loaded = useRef<string | null>(null)
  const range = useRef<Playing | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState<number | null>(null)
  const [failed, setFailed] = useState(false)

  const stop = useCallback(() => {
    range.current = null
    audioRef.current?.pause()
    setPlaying(null)
  }, [])

  const play = useCallback(
    async (key: string, start: number, end: number): Promise<void> => {
      const audio = audioRef.current
      if (!audio) return
      const url = await resolve()
      if (!url) {
        setFailed(true)
        return
      }
      setFailed(false)
      if (loaded.current !== url) {
        loaded.current = url
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
      }
      audio.currentTime = start
      range.current = { key, end }
      setPlaying(key)
      setTime(start)
      try {
        await audio.play()
      } catch {
        range.current = null
        setPlaying(null)
        setFailed(audio.error !== null)
      }
    },
    [resolve]
  )

  const toggle = useCallback(
    (key: string, start: number, end: number) => {
      if (playing === key) stop()
      else void play(key, start, end)
    },
    [play, playing, stop]
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
          audio.pause()
        }
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing])

  // Leaving the dialog stops the sound.
  useEffect(() => {
    const audio = audioRef.current
    return () => audio?.pause()
  }, [])

  return {
    playing,
    time,
    duration,
    failed,
    play,
    stop,
    toggle,
    element: (
      <audio
        ref={audioRef}
        hidden
        preload="metadata"
        onPlay={(event) => playExclusively(event.currentTarget)}
        onPause={() => {
          range.current = null
          setPlaying(null)
        }}
        onEnded={() => {
          range.current = null
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
