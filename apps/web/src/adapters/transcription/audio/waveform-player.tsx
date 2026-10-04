import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type Ref
} from 'react'
import { PauseIcon, PlayIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@ki4jlu/design-system'
import {
  TRANSCRIPTION_SPEAKER_COLORS,
  TRANSCRIPTION_WAVEFORM_DECODE_MAX_BYTES,
  type TranscriptionSpeakerColorId
} from '@justcampus/shared'
import { cn } from '@/lib/utils'
import { drawWaveform, type WaveformColors } from './draw'
import { playExclusively } from './exclusive'
import {
  blobWaveform,
  formatMegabytes,
  formatTime,
  placeholderPeaks,
  urlWaveform,
  type DecodedWaveform
} from './peaks'

/** A stretch of the speaker timeline under the waveform (T-24). */
export interface WaveformSegment {
  start: number
  end: number
  /** `null` draws it in the neutral colour. */
  colorId: TranscriptionSpeakerColorId | null
}

/** A highlighted window, e.g. the voice sample being edited (T-19). */
export interface WaveformRegion {
  start: number
  end: number
}

/** What a page can do with a player besides its own controls. */
export interface WaveformPlayerHandle {
  play: () => Promise<void>
  pause: () => void
  /** Jumps to a time in seconds, clamped to the audio. */
  seek: (seconds: number) => void
  /** Plays from `start` and pauses at `end`, e.g. one speaker block or voice sample. */
  playRange: (start: number, end: number) => Promise<void>
  currentTime: () => number
  /** The audio element, e.g. to share it with a recording. */
  audio: () => HTMLAudioElement | null
}

export interface WaveformPlayerProps {
  /** A local file or recording, or a signed URL; `null` shows an empty player. */
  source: Blob | string | null
  /** Shown above the waveform and names the seek bar. */
  name?: string
  /** Size in bytes, shown and checked against the decode limit; a blob's own size by default. */
  size?: number
  /** The speaker timeline, coloured per speaker. */
  segments?: readonly WaveformSegment[]
  region?: WaveformRegion | null
  /** Hides the line with name, size and time, for players that show them elsewhere. */
  compact?: boolean
  onTimeUpdate?: (seconds: number) => void
  onPlayingChange?: (playing: boolean) => void
  /** The duration once known, from the media or the decoded waveform. */
  onDuration?: (seconds: number) => void
  className?: string
  ref?: Ref<WaveformPlayerHandle>
}

/** Every mounted player's audio, so starting one pauses the others. */
const players = new Set<HTMLAudioElement>()

/** Seconds the arrow keys move, and Page Up and Page Down. */
const SEEK_STEP = 5
const SEEK_PAGE = 30

function cssColor(element: Element, name: string): string {
  return getComputedStyle(element).getPropertyValue(name).trim()
}

/**
 * The audio player the transcription page uses everywhere, after kiChat's `WaveformAudioPlayer`
 * and its global player: play/pause, a waveform that is the seek bar (pointer and keyboard), the
 * time, an optional speaker timeline and a highlighted region. Local files play from an object
 * URL; remote audio from a signed URL. Above 100 MB no waveform is decoded, but the audio plays.
 */
export function WaveformPlayer({
  source,
  name,
  size,
  segments,
  region,
  compact = false,
  onTimeUpdate,
  onPlayingChange,
  onDuration,
  className,
  ref
}: WaveformPlayerProps): React.JSX.Element {
  const { t } = useTranslation()
  const audioRef = useRef<HTMLAudioElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const [decoded, setDecoded] = useState<{
    source: Blob | string
    waveform: DecodedWaveform | null
  } | null>(null)
  const [duration, setDuration] = useState(0)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const rangeEnd = useRef<number | null>(null)
  const seeking = useRef(false)
  const byteSize = size ?? (source instanceof Blob ? source.size : undefined)
  const tooLarge = byteSize !== undefined && byteSize > TRANSCRIPTION_WAVEFORM_DECODE_MAX_BYTES
  // A waveform decoded for an earlier source no longer counts.
  const waveform = decoded?.source === source ? decoded.waveform : null

  // Local audio plays from an object URL that lives as long as the source.
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    if (!source) {
      audio.removeAttribute('src')
      audio.load()
      return
    }
    const url = source instanceof Blob ? URL.createObjectURL(source) : source
    audio.src = url
    return () => {
      if (source instanceof Blob) URL.revokeObjectURL(url)
    }
  }, [source])

  useEffect(() => {
    if (!source || tooLarge) return
    const controller = new AbortController()
    const decoding =
      source instanceof Blob ? blobWaveform(source) : urlWaveform(source, controller.signal)
    void decoding.then((result) => {
      if (!controller.signal.aborted) setDecoded({ source, waveform: result })
    })
    return () => controller.abort()
  }, [source, tooLarge])

  const knownDuration = duration || waveform?.duration || 0
  useEffect(() => {
    if (knownDuration > 0) onDuration?.(knownDuration)
  }, [knownDuration, onDuration])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const bar = barRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !bar || !context) return
    const width = bar.clientWidth
    const height = bar.clientHeight
    if (width === 0 || height === 0) return
    const ratio = window.devicePixelRatio || 1
    canvas.width = width * ratio
    canvas.height = height * ratio
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    // The design system's tokens, read at draw time so light and dark themes both apply.
    const colors: WaveformColors = {
      played: cssColor(bar, '--color-primary'),
      unplayed: cssColor(bar, '--color-outline-variant'),
      region: cssColor(bar, '--color-primary-container'),
      neutral: cssColor(bar, '--color-outline'),
      speakers: TRANSCRIPTION_SPEAKER_COLORS
    }
    drawWaveform(context, {
      width,
      height,
      peaks: waveform?.peaks ?? placeholderPeaks(),
      duration: knownDuration,
      time: audioRef.current?.currentTime ?? 0,
      segments: segments ?? [],
      region: region ?? null,
      colors
    })
  }, [waveform, knownDuration, segments, region])

  useEffect(() => {
    draw()
    const bar = barRef.current
    if (!bar) return
    const observer = new ResizeObserver(() => draw())
    observer.observe(bar)
    return () => observer.disconnect()
  }, [draw])

  // While playing, the playhead moves every frame and a range stops at its end.
  useEffect(() => {
    if (!playing) return
    let frame = 0
    const tick = (): void => {
      const audio = audioRef.current
      if (audio && rangeEnd.current !== null && audio.currentTime >= rangeEnd.current) {
        rangeEnd.current = null
        audio.pause()
      }
      draw()
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing, draw])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    players.add(audio)
    return () => {
      players.delete(audio)
      audio.pause()
    }
  }, [])

  const seek = useCallback(
    (seconds: number) => {
      const audio = audioRef.current
      if (!audio || !knownDuration) return
      audio.currentTime = Math.min(Math.max(0, seconds), knownDuration)
      setTime(audio.currentTime)
      onTimeUpdate?.(audio.currentTime)
      draw()
    },
    [knownDuration, onTimeUpdate, draw]
  )

  const play = useCallback(async () => {
    const audio = audioRef.current
    if (!audio) return
    for (const other of players) if (other !== audio) other.pause()
    try {
      await audio.play()
    } catch {
      // Refused (no user gesture, unsupported source); the button stays on play.
    }
  }, [])

  const pause = useCallback(() => audioRef.current?.pause(), [])

  useImperativeHandle(
    ref,
    () => ({
      play: () => {
        rangeEnd.current = null
        return play()
      },
      pause,
      seek,
      playRange: (start, end) => {
        seek(start)
        rangeEnd.current = end
        return play()
      },
      currentTime: () => audioRef.current?.currentTime ?? 0,
      audio: () => audioRef.current
    }),
    [play, pause, seek]
  )

  const seekToPointer = (event: PointerEvent<HTMLDivElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width === 0) return
    seek(((event.clientX - rect.left) / rect.width) * knownDuration)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const current = audioRef.current?.currentTime ?? 0
    const target = {
      ArrowLeft: current - SEEK_STEP,
      ArrowDown: current - SEEK_STEP,
      ArrowRight: current + SEEK_STEP,
      ArrowUp: current + SEEK_STEP,
      PageDown: current - SEEK_PAGE,
      PageUp: current + SEEK_PAGE,
      Home: 0,
      End: knownDuration
    }[event.key]
    if (target === undefined) return
    event.preventDefault()
    seek(target)
  }

  const timeLabel = `${formatTime(time)} / ${formatTime(knownDuration)}`
  const playLabel = playing
    ? t('transcription.common.player.pause')
    : t('transcription.common.player.play')

  return (
    <div className={cn('flex min-w-0 flex-col gap-2', className)}>
      {compact ? null : (
        <div className="flex min-w-0 items-baseline justify-between gap-3">
          <span className="min-w-0 truncate">
            {name}
            {byteSize !== undefined ? ` · ${formatMegabytes(byteSize)}` : null}
          </span>
          <span aria-hidden="true" className="shrink-0">
            {timeLabel}
          </span>
        </div>
      )}
      <div className="flex min-w-0 items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={playLabel}
          title={playLabel}
          disabled={!source}
          onClick={() => {
            if (playing) pause()
            else {
              rangeEnd.current = null
              void play()
            }
          }}
        >
          {playing ? (
            <PauseIcon aria-hidden="true" className="size-4" />
          ) : (
            <PlayIcon aria-hidden="true" className="size-4" />
          )}
        </Button>
        {/* DS gap: no seek slider or media timeline; the waveform canvas is the bar, with a focus ring from the tokens. */}
        <div
          ref={barRef}
          role="slider"
          tabIndex={source ? 0 : -1}
          aria-label={
            name
              ? t('transcription.common.player.seek', { name })
              : t('transcription.common.player.seekUnnamed')
          }
          aria-valuemin={0}
          aria-valuemax={Math.round(knownDuration)}
          aria-valuenow={Math.round(time)}
          aria-valuetext={t('transcription.common.player.time', {
            current: formatTime(time),
            total: formatTime(knownDuration)
          })}
          aria-disabled={!source || undefined}
          className="relative h-12 min-w-0 flex-1 cursor-pointer touch-none focus-visible:outline-2 focus-visible:outline-focus-ring"
          onKeyDown={onKeyDown}
          onPointerDown={(event) => {
            if (!knownDuration) return
            seeking.current = true
            event.currentTarget.setPointerCapture(event.pointerId)
            seekToPointer(event)
          }}
          onPointerMove={(event) => {
            if (seeking.current) seekToPointer(event)
          }}
          onPointerUp={(event) => {
            seeking.current = false
            event.currentTarget.releasePointerCapture(event.pointerId)
          }}
          onPointerCancel={() => {
            seeking.current = false
          }}
        >
          <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 size-full" />
        </div>
      </div>
      {tooLarge && !compact ? (
        <span>{t('transcription.common.player.waveformUnavailable')}</span>
      ) : null}
      <audio
        ref={audioRef}
        preload="metadata"
        hidden
        onEmptied={() => {
          setDuration(0)
          setTime(0)
        }}
        onLoadedMetadata={(event) => {
          // Recordings may report Infinity; the decoded waveform's duration covers them.
          const value = event.currentTarget.duration
          if (Number.isFinite(value)) setDuration(value)
        }}
        onTimeUpdate={(event) => {
          setTime(event.currentTarget.currentTime)
          onTimeUpdate?.(event.currentTarget.currentTime)
        }}
        onPlay={(event) => {
          playExclusively(event.currentTarget)
          setPlaying(true)
          onPlayingChange?.(true)
        }}
        onPause={() => {
          setPlaying(false)
          onPlayingChange?.(false)
          draw()
        }}
        onEnded={() => {
          rangeEnd.current = null
          setPlaying(false)
          onPlayingChange?.(false)
        }}
      />
    </div>
  )
}
