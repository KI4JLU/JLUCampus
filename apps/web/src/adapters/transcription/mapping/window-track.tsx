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

/** How close to an edge, in pixels, a press grabs it rather than the window. */
const EDGE_PX = 8
/** Pixels the pointer moves before a press counts as a drag (kiChat: 3). */
const DRAG_PX = 3
/** Seconds the arrow keys move the window, and with Shift. */
const KEY_STEP = 0.1
const KEY_STEP_LARGE = 1

type DragMode = 'start' | 'end' | 'window' | 'outside'

interface Drag {
  mode: DragMode
  x: number
  time: number
  window: TimeWindow
  scale: TrackScale
  moved: boolean
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
}

/**
 * The sample window over the whole file's waveform, after kiChat's editor player (T-19): the window
 * takes a tenth of the track, the audio before and after it the rest (`trackScale`). Dragging an
 * edge changes the window between 0.2 and 5 seconds and pushes it along beyond that, dragging the
 * window moves it, a click plays from there. The arrow keys move it too; the start and end fields
 * beside it set it exactly.
 */
export function WindowTrack(props: WindowTrackProps): React.JSX.Element {
  const { window, duration, peaks, playhead, onChange, onClick } = props
  const { t } = useTranslation()
  const barRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drag = useRef<Drag | null>(null)
  // While dragging the scale stays put, so the track does not shift under the pointer (kiChat's
  // `frozenMetrics`); it zooms onto the moved window when the drag ends.
  const [frozen, setFrozen] = useState<TrackScale | null>(null)
  const [hover, setHover] = useState<DragMode>('outside')
  const live = useMemo(
    () => trackScale({ start: window.start, end: window.end }, duration),
    [window.start, window.end, duration]
  )
  const scale = frozen ?? live

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const bar = barRef.current
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
      region: cssColor(bar, '--color-primary-container'),
      speakers: TRANSCRIPTION_SPEAKER_COLORS
    }
    // Drawn on the track's own scale, from 0 to 1: one peak per bar, the window and the playhead
    // where the scale puts them.
    drawWaveform(context, {
      width,
      height,
      peaks: trackBarPeaks(scale, peaks, width, BAR_STEP),
      duration: 1,
      time: playhead === null ? 0 : scale.toFraction(playhead),
      segments: [],
      region: { start: scale.toFraction(window.start), end: scale.toFraction(window.end) },
      colors
    })
  }, [peaks, playhead, scale, window.end, window.start])

  useEffect(() => {
    draw()
    const bar = barRef.current
    if (!bar) return
    const observer = new ResizeObserver(() => draw())
    observer.observe(bar)
    return () => observer.disconnect()
  }, [draw])

  const timeAt = (clientX: number, on: TrackScale): number => {
    const rect = barRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return on.start
    return on.toTime((clientX - rect.left) / rect.width)
  }

  const modeAt = (clientX: number): DragMode => {
    const rect = barRef.current?.getBoundingClientRect()
    if (!rect || rect.width === 0) return 'outside'
    const toX = (seconds: number): number => scale.toFraction(seconds) * rect.width
    const x = clientX - rect.left
    if (Math.abs(x - toX(window.start)) <= EDGE_PX) return 'start'
    if (Math.abs(x - toX(window.end)) <= EDGE_PX) return 'end'
    const time = timeAt(clientX, scale)
    return time >= window.start && time <= window.end ? 'window' : 'outside'
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = {
      mode: modeAt(event.clientX),
      x: event.clientX,
      time: timeAt(event.clientX, scale),
      window,
      scale,
      moved: false
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
    if (current.mode === 'start' || current.mode === 'end') {
      onChange(moveWindowEdge(window, current.mode, time, duration))
    } else if (current.mode === 'window') {
      onChange(slideWindow(current.window, current.window.start + time - current.time, duration))
    }
  }

  const endDrag = (event: PointerEvent<HTMLDivElement>, click: boolean): void => {
    const current = drag.current
    drag.current = null
    setFrozen(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (click && current && !current.moved) onClick(current.time)
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
      <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 size-full" />
    </div>
  )
}
