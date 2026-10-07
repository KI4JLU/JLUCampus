import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
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
import { drawWaveform, segmentTitle, type WaveformColors } from './draw'
import { playExclusively } from './exclusive'
import { sourceLength, type MediaLength } from './length'
import {
  blobWaveform,
  formatMegabytes,
  formatTime,
  jobWaveform,
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
  /** The speaker, shown with the stretch's times when the pointer rests on it. */
  label?: string
}

/**
 * A time line the bar shows and seeks instead of this audio's own, e.g. the result's one waveform
 * over all source files (T-24): its peaks, length and playhead, in its own seconds, as are the
 * `segments`; a seek by pointer or keys goes to `onSeek`.
 */
export interface WaveformTimeline {
  /** `null` draws the placeholder bars. */
  peaks: readonly number[] | null
  duration: number
  time: number
  onSeek: (seconds: number) => void
  /** This audio's length when its media reports none (recordings), e.g. its file's saved range. */
  sourceDuration?: number
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
  /** A local file or recording, or a job's audio URL; `null` shows an empty player. */
  source: Blob | string | null
  /** Shown above the waveform and names the seek bar. */
  name?: string
  /** Size in bytes, shown and checked against the decode limit; a blob's own size by default. */
  size?: number
  /**
   * The analysed job of this audio: above the decode limit the waveform the analysis computed is
   * drawn instead (T-12).
   */
  jobId?: string | null
  /**
   * Asks for the job's computed waveform again when it changes, e.g. once the analysis ended; a
   * waveform not found before is not remembered.
   */
  jobRevision?: string
  /** The speaker timeline, coloured per speaker. */
  segments?: readonly WaveformSegment[]
  region?: WaveformRegion | null
  /** Shows and seeks another time line than the audio's own; nothing is decoded here then. */
  timeline?: WaveformTimeline
  /** Hides the line with name, size and time, for players that show them elsewhere. */
  compact?: boolean
  onTimeUpdate?: (seconds: number) => void
  onPlayingChange?: (playing: boolean) => void
  /**
   * The duration once known, from the media or the decoded waveform, and only after the media of
   * the current source reported its metadata, so a seek waiting for it lands on that source.
   */
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
 * URL; remote audio from the job's audio URL. Above 100 MB nothing is decoded here: the waveform the
 * analysis computed is drawn (`jobId`), and the audio plays either way.
 */
export function WaveformPlayer({
  source,
  name,
  size,
  jobId = null,
  jobRevision,
  segments,
  region,
  timeline,
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
  /** What the media reported for the source it loaded; an earlier source's no longer counts. */
  const [media, setMedia] = useState<MediaLength | null>(null)
  /** The source the audio element was last given, which its metadata belongs to. */
  const loading = useRef<Blob | string | null>(null)
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const rangeEnd = useRef<number | null>(null)
  const seeking = useRef(false)
  const byteSize = size ?? (source instanceof Blob ? source.size : undefined)
  const tooLarge = byteSize !== undefined && byteSize > TRANSCRIPTION_WAVEFORM_DECODE_MAX_BYTES
  // A waveform decoded for an earlier source no longer counts.
  const waveform = decoded?.source === source ? decoded.waveform : null
  const external = timeline !== undefined
  // Read at draw time, so the playhead follows without drawing anew on every render.
  const shownTimeline = useRef(timeline)
  useLayoutEffect(() => {
    shownTimeline.current = timeline
  })

  // Local audio plays from an object URL that lives as long as the source.
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    loading.current = source
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
    if (!source || external) return
    const controller = new AbortController()
    // Too large to decode here: the waveform the analysis computed, once there is one.
    const decoding = tooLarge
      ? jobId
        ? jobWaveform(jobId)
        : null
      : source instanceof Blob
        ? blobWaveform(source)
        : urlWaveform(source, controller.signal)
    if (!decoding) return
    void decoding.then((result) => {
      if (!controller.signal.aborted) setDecoded({ source, waveform: result })
    })
    return () => controller.abort()
    // `jobRevision` only asks again; `jobWaveform` keeps what it found.
  }, [jobId, jobRevision, source, tooLarge, external])

  const knownDuration = sourceLength(source, media, waveform?.duration, timeline?.sourceDuration)
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
    const shown = shownTimeline.current
    drawWaveform(context, {
      width,
      height,
      peaks: (shown ? shown.peaks : waveform?.peaks) ?? placeholderPeaks(),
      duration: shown ? shown.duration : knownDuration,
      time: shown ? shown.time : (audioRef.current?.currentTime ?? 0),
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

  // Another time line is drawn whenever it changes.
  useEffect(() => {
    if (external) draw()
  }, [external, timeline?.peaks, timeline?.duration, timeline?.time, draw])

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

  // The bar's time line: the audio's own, or the one given.
  const barDuration = timeline ? timeline.duration : knownDuration
  const barTime = timeline ? timeline.time : time
  const seekBar = (seconds: number): void => {
    if (timeline) timeline.onSeek(Math.min(Math.max(0, seconds), timeline.duration))
    else seek(seconds)
  }

  const pointerTime = (event: PointerEvent<HTMLDivElement>): number | null => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width === 0) return null
    return Math.min(Math.max(0, (event.clientX - rect.left) / rect.width), 1) * barDuration
  }

  const seekToPointer = (event: PointerEvent<HTMLDivElement>): void => {
    const target = pointerTime(event)
    if (target !== null) seekBar(target)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const current = timeline ? timeline.time : (audioRef.current?.currentTime ?? 0)
    const target = {
      ArrowLeft: current - SEEK_STEP,
      ArrowDown: current - SEEK_STEP,
      ArrowRight: current + SEEK_STEP,
      ArrowUp: current + SEEK_STEP,
      PageDown: current - SEEK_PAGE,
      PageUp: current + SEEK_PAGE,
      Home: 0,
      End: barDuration
    }[event.key]
    if (target === undefined) return
    event.preventDefault()
    seekBar(target)
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
          aria-valuemax={Math.round(barDuration)}
          aria-valuenow={Math.round(barTime)}
          aria-valuetext={t('transcription.common.player.time', {
            current: formatTime(barTime),
            total: formatTime(barDuration)
          })}
          aria-disabled={!source || undefined}
          className="relative h-12 min-w-0 flex-1 cursor-pointer touch-none focus-visible:outline-2 focus-visible:outline-focus-ring"
          onKeyDown={onKeyDown}
          onPointerDown={(event) => {
            if (!barDuration) return
            seeking.current = true
            event.currentTarget.setPointerCapture(event.pointerId)
            seekToPointer(event)
          }}
          onPointerMove={(event) => {
            if (seeking.current) {
              seekToPointer(event)
              return
            }
            // The speaker under the pointer, as kiChat's global player shows it.
            if (!segments?.some((segment) => segment.label)) return
            const at = pointerTime(event)
            event.currentTarget.title = at === null ? '' : segmentTitle(segments, at)
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
      {tooLarge && !waveform && !compact ? (
        <span>{t('transcription.common.player.waveformUnavailable')}</span>
      ) : null}
      <audio
        ref={audioRef}
        preload="metadata"
        hidden
        onEmptied={() => setTime(0)}
        onLoadedMetadata={(event) => {
          // Recordings may report Infinity; the decoded waveform's duration covers them, or the
          // time line's length of this file (`sourceLength`).
          const loaded = loading.current
          if (loaded) setMedia({ source: loaded, duration: event.currentTarget.duration })
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
