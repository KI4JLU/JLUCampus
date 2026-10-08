import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent
} from 'react'
import { useTranslation } from 'react-i18next'
import { TRANSCRIPTION_SPEAKER_COLORS } from '@justcampus/shared'
import { cn } from '@/lib/utils'
import { BAR_STEP, drawWaveform, type WaveformColors } from '../audio/draw'
import { formatWindowTime, moveWindowEdge, slideWindow, type TimeWindow } from './speakers'
import { trackBarPeaks, trackScale, type TrackScale } from './track-scale'
import type { TimePeaks } from './window-peaks'

/** Width in pixels of the grip at each edge (`w-3`), which sits just outside the window. */
const HANDLE_PX = 12
/** Pixels beyond its grip a press still grabs an edge. */
const GRACE_PX = 4
/** Pixels the pointer moves before a press counts as a drag (kiChat: 3). */
const DRAG_PX = 3
/** Seconds the arrow keys move the window, and with Shift. */
const KEY_STEP = 0.1
const KEY_STEP_LARGE = 1

type DragMode = 'start' | 'end' | 'window' | 'outside'

interface Drag {
  mode: DragMode
  x: number
  /** The time where the press was. */
  time: number
  /** The time under the pointer now. */
  at: number
  window: TimeWindow
  scale: TrackScale
  moved: boolean
  /** Whether the sample played when pressed. */
  playing: boolean
}

function cssColor(element: Element, name: string): string {
  return getComputedStyle(element).getPropertyValue(name).trim()
}

export interface WindowTrackProps {
  window: TimeWindow
  duration: number | null
  peaks: TimePeaks | null
  /** The playhead while this sample plays, else `null`. */
  playhead: number | null
  /** Names the track, e.g. `Window of Sample 1`. */
  label: string
  describedBy?: string
  onChange: (window: TimeWindow) => void
  /** A click without dragging: play from there, or stop (kiChat's editor). */
  onClick: (time: number) => void
  /**
   * Dragging beside the window scrubs: the pointer's time, at every move, and whether the sample
   * played when the drag began.
   */
  onScrub: (time: number, startedPlaying: boolean) => void
  /** Where a scrub was let go. */
  onScrubEnd: (time: number) => void
}

/**
 * The sample window over the whole file's waveform, after kiChat's editor player (T-19): the window
 * takes a tenth of the track, the audio before and after it the rest (`trackScale`). Dragging an
 * edge changes the window between 0.2 and 5 seconds and pushes it along beyond that, dragging the
 * window moves it, dragging beside it scrubs (the playhead follows the pointer), a click plays from
 * there. The window shows as a light tint behind the bars between two grips, one just outside each
 * edge; the bars stay neutral and the playhead is a line. The arrow keys move it too; the start and
 * end fields beside it set it exactly.
 */
export function WindowTrack(props: WindowTrackProps): React.JSX.Element {
  const { window, duration, peaks, playhead, onChange, onClick, onScrub, onScrubEnd } = props
  const { t } = useTranslation()
  const barRef = useRef<HTMLDivElement>(null)
  // The track proper, inset by a grip's width on both sides, so the grips fit beside a window at
  // the file's start or end.
  const trackRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drag = useRef<Drag | null>(null)
  // While dragging the scale stays put, so the track does not shift under the pointer (kiChat's
  // `frozenMetrics`); it zooms onto the moved window when the drag ends.
  const [frozen, setFrozen] = useState<TrackScale | null>(null)
  const [hover, setHover] = useState<DragMode>('outside')
  // The playhead under the pointer while scrubbing, ahead of the sound that follows it.
  const [scrub, setScrub] = useState<number | null>(null)
  const shownPlayhead = scrub ?? playhead
  const live = useMemo(
    () => trackScale({ start: window.start, end: window.end }, duration),
    [window.start, window.end, duration]
  )
  const scale = frozen ?? live

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const bar = trackRef.current
    const context = canvas?.getContext('2d')
    if (!canvas || !bar || !context) return
    const width = bar.clientWidth
    const height = bar.clientHeight
    if (width === 0 || height === 0) return
    const ratio = globalThis.devicePixelRatio || 1
    canvas.width = width * ratio
    canvas.height = height * ratio
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    const colors: WaveformColors = {
      played: cssColor(bar, '--color-primary'),
      unplayed: cssColor(bar, '--color-outline-variant'),
      region: '',
      speakers: TRANSCRIPTION_SPEAKER_COLORS
    }
    // Drawn on the track's own scale, from 0 to 1, one peak per bar, all in the neutral colour: no
    // played part, so no primary bars beside the window. The window is the tint and grips below,
    // the playhead a line of its own.
    drawWaveform(context, {
      width,
      height,
      peaks: trackBarPeaks(scale, peaks, width, BAR_STEP),
      duration: 1,
      time: 0,
      segments: [],
      region: null,
      colors
    })
  }, [peaks, scale])

  useEffect(() => {
    draw()
    const bar = trackRef.current
    if (!bar) return
    const observer = new ResizeObserver(() => draw())
    observer.observe(bar)
    return () => observer.disconnect()
  }, [draw])

  const timeAt = (clientX: number, on: TrackScale): number => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return on.start
    return on.toTime((clientX - rect.left) / rect.width)
  }

  const modeAt = (clientX: number): DragMode => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return 'outside'
    const toX = (seconds: number): number => scale.toFraction(seconds) * rect.width
    const x = clientX - rect.left
    // Each grip lies outside its edge: the start's left of it, the end's right of it.
    const start = toX(window.start)
    const end = toX(window.end)
    if (x >= start - HANDLE_PX - GRACE_PX && x <= start + GRACE_PX) return 'start'
    if (x >= end - GRACE_PX && x <= end + HANDLE_PX + GRACE_PX) return 'end'
    const time = timeAt(clientX, scale)
    return time >= window.start && time <= window.end ? 'window' : 'outside'
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = {
      mode: modeAt(event.clientX),
      x: event.clientX,
      time: timeAt(event.clientX, scale),
      at: timeAt(event.clientX, scale),
      window,
      scale,
      moved: false,
      playing: playhead !== null
    }
    setFrozen(scale)
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const current = drag.current
    if (!current) {
      setHover(modeAt(event.clientX))
      return
    }
    if (!current.moved && Math.abs(event.clientX - current.x) < DRAG_PX) return
    current.moved = true
    const time = timeAt(event.clientX, current.scale)
    current.at = time
    if (current.mode === 'start' || current.mode === 'end') {
      onChange(moveWindowEdge(window, current.mode, time, duration))
    } else if (current.mode === 'window') {
      onChange(slideWindow(current.window, current.window.start + time - current.time, duration))
    } else {
      setScrub(time)
      onScrub(time, current.playing)
    }
  }

  const endDrag = (event: PointerEvent<HTMLDivElement>, click: boolean): void => {
    const current = drag.current
    drag.current = null
    setFrozen(null)
    setScrub(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (!click || !current) return
    if (!current.moved) onClick(current.time)
    else if (current.mode === 'outside') onScrubEnd(current.at)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP
    const length = window.end - window.start
    const target = {
      ArrowLeft: window.start - step,
      ArrowDown: window.start - step,
      ArrowRight: window.start + step,
      ArrowUp: window.start + step,
      Home: 0,
      End: duration !== null ? duration - length : window.start
    }[event.key]
    if (target === undefined) return
    event.preventDefault()
    onChange(slideWindow(window, target, duration))
  }

  // Where the window and the playhead lie on the track, in percent.
  const windowLeft = scale.toFraction(window.start) * 100
  const windowRight = scale.toFraction(window.end) * 100
  const playheadAt = shownPlayhead === null ? null : scale.toFraction(shownPlayhead) * 100

  const cursor =
    hover === 'start' || hover === 'end'
      ? 'cursor-ew-resize'
      : hover === 'window'
        ? 'cursor-grab'
        : 'cursor-pointer'

  return (
    // DS gap: no range slider with two thumbs; the waveform canvas is the track, with a focus ring
    // from the tokens.
    <div
      ref={barRef}
      role="slider"
      tabIndex={0}
      aria-label={props.label}
      aria-describedby={props.describedBy}
      aria-valuemin={0}
      aria-valuemax={Math.max(0, Math.round((duration ?? window.end) * 100) / 100)}
      aria-valuenow={window.start}
      aria-valuetext={t('transcription.upload.mapping.sampleWindowValue', {
        start: formatWindowTime(window.start),
        end: formatWindowTime(window.end)
      })}
      className={cn(
        'relative h-16 min-w-0 flex-1 touch-none focus-visible:outline-2 focus-visible:outline-focus-ring',
        cursor
      )}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(event) => endDrag(event, true)}
      onPointerCancel={(event) => endDrag(event, false)}
      onPointerLeave={() => {
        if (!drag.current) setHover('outside')
      }}
    >
      {/* DS gap: no range slider with two thumbs, as above; the window is a light primary tint
      behind the bars between two grips, primary brackets just outside its edges with grip lines,
      and the playhead a primary line over the track, all from the tokens. */}
      <div ref={trackRef} className="pointer-events-none absolute inset-y-0 inset-x-3">
        <div
          aria-hidden="true"
          className="absolute inset-y-0 bg-primary/10"
          style={{ left: `${windowLeft}%`, width: `${windowRight - windowLeft}%` }}
        />
        <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 size-full" />
        {[windowLeft, windowRight].map((at, index) => (
          <div
            key={index}
            aria-hidden="true"
            className={cn(
              'absolute inset-y-0 flex w-3 items-center justify-center gap-0.5 bg-primary',
              index === 0 ? '-translate-x-full rounded-l-md' : 'rounded-r-md'
            )}
            style={{ left: `${at}%` }}
          >
            <span className="h-4 w-px rounded-full bg-on-primary" />
            <span className="h-4 w-px rounded-full bg-on-primary" />
          </div>
        ))}
        {playheadAt !== null && (
          <div
            aria-hidden="true"
            className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-primary"
            style={{ left: `${playheadAt}%` }}
          />
        )}
      </div>
    </div>
  )
}
