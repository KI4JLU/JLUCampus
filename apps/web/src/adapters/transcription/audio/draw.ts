import type { TranscriptionSpeakerColorId } from '@justcampus/shared'
import { formatTime } from './peaks'

/** The colours a waveform is drawn in, from the design tokens and the speaker palette. */
export interface WaveformColors {
  played: string
  unplayed: string
  region: string
  /** Speaker timeline stretches without a speaker colour. */
  neutral: string
  speakers: Record<TranscriptionSpeakerColorId, string>
}

export interface WaveformDrawing {
  width: number
  height: number
  peaks: readonly number[]
  /** Seconds; 0 while unknown, which draws everything unplayed. */
  duration: number
  time: number
  segments: ReadonlyArray<{
    start: number
    end: number
    colorId: TranscriptionSpeakerColorId | null
  }>
  region: { start: number; end: number } | null
  colors: WaveformColors
}

/** Bar width and gap, as in kiChat's player. */
const BAR = 3
const GAP = 3
/** Pixels from one bar to the next; one peak per bar is drawn as is. */
export const BAR_STEP = BAR + GAP
/** Height of the speaker timeline under the bars. */
const TIMELINE = 4

/** The x position of a time, or 0 while the duration is unknown. */
export function timeToX(seconds: number, duration: number, width: number): number {
  if (duration <= 0) return 0
  return (Math.min(Math.max(seconds, 0), duration) / duration) * width
}

/**
 * The hover text of the speaker timeline at a time, kiChat's global player title:
 * `<speaker>: mm:ss - mm:ss` of the stretch under the pointer, `''` where there is none or it has
 * no label.
 */
export function segmentTitle(
  segments: ReadonlyArray<{ start: number; end: number; label?: string }>,
  time: number
): string {
  const segment = segments.find((stretch) => time >= stretch.start && time < stretch.end)
  return segment?.label
    ? `${segment.label}: ${formatTime(segment.start)} - ${formatTime(segment.end)}`
    : ''
}

/**
 * Draws bars resampled from the peaks, the played part in the primary colour, a highlighted region
 * behind them, the speaker timeline at the bottom and a thin playhead.
 */
export function drawWaveform(context: CanvasRenderingContext2D, drawing: WaveformDrawing): void {
  const { width, height, peaks, duration, time, segments, region, colors } = drawing
  context.clearRect(0, 0, width, height)
  const timeline = segments.length > 0 ? TIMELINE + 2 : 0
  const barArea = height - timeline

  if (region && duration > 0) {
    const start = timeToX(region.start, duration, width)
    context.fillStyle = colors.region
    context.fillRect(start, 0, Math.max(1, timeToX(region.end, duration, width) - start), barArea)
  }

  const progressX = timeToX(time, duration, width)
  const count = Math.max(1, Math.floor(width / (BAR + GAP)))
  const center = barArea / 2
  for (let index = 0; index < count; index++) {
    const peak = peaks[Math.floor((index / count) * peaks.length)] ?? 0
    const barHeight = Math.max(2, peak * (barArea - 2))
    const x = index * (BAR + GAP)
    context.fillStyle = x + BAR / 2 <= progressX ? colors.played : colors.unplayed
    context.beginPath()
    context.roundRect(x, center - barHeight / 2, BAR, barHeight, BAR / 2)
    context.fill()
  }

  if (duration > 0) {
    for (const segment of segments) {
      const start = timeToX(segment.start, duration, width)
      context.fillStyle =
        segment.colorId === null ? colors.neutral : colors.speakers[segment.colorId]
      context.fillRect(
        start,
        height - TIMELINE,
        Math.max(1, timeToX(segment.end, duration, width) - start),
        TIMELINE
      )
    }
  }

  if (progressX > 0) {
    context.fillStyle = colors.played
    context.fillRect(progressX - 0.5, 0, 1, barArea)
  }
}
