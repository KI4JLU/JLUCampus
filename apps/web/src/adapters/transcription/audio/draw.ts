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
  /** A file's processing progress over the bars; `null` or left out draws none. */
  progress?: WaveformProgress | null
}

/**
 * How far a file's processing got, drawn over the bars: the bars up to it in the played colour at
 * half strength, so the played part (full strength) still reads on top of it, and a glow running
 * over the filled bars.
 */
export interface WaveformProgress {
  /** 0 to 100, as shown: between two reported values while it eases towards the newer one. */
  percent: number
  /** Where the glow is in its run over the filled bars, 0 to 1; `null` draws none. */
  glow: number | null
}

/** Bar width and gap, as in kiChat's player. */
const BAR = 3
const GAP = 3
/** Pixels from one bar to the next; one peak per bar is drawn as is. */
export const BAR_STEP = BAR + GAP
/** Height of the speaker timeline under the bars. */
const TIMELINE = 4
/** Strength of the bars filled by the progress, below the played ones. */
export const PROGRESS_ALPHA = 0.55
/** Half width in pixels of the glow running over the filled bars. */
const GLOW_RADIUS = 36
/** Milliseconds for the shown progress to cover about two thirds of a jump. */
const PROGRESS_EASE = 250

/** How many bars fit the width; one at least. */
export function barCount(width: number): number {
  return Math.max(1, Math.floor(width / BAR_STEP))
}

/** How many bars from the left the progress fills: those whose centre it reached. */
export function filledBars(width: number, percent: number): number {
  const limit = (Math.min(Math.max(percent, 0), 100) / 100) * width
  if (limit < BAR / 2) return 0
  return Math.min(barCount(width), Math.floor((limit - BAR / 2) / BAR_STEP) + 1)
}

/**
 * The shown progress a frame later: it eases towards the reported one, quickly at first, and
 * lands on it once less than a twentieth of a percent remains.
 */
export function easeProgress(shown: number, target: number, elapsed: number): number {
  const next = shown + (target - shown) * (1 - Math.exp(-Math.max(elapsed, 0) / PROGRESS_EASE))
  return Math.abs(target - next) < 0.05 ? target : next
}

/**
 * A filled bar's strength: half, up to full under the glow, which enters left of the filled bars
 * and leaves right of them, and full for the bar at the progress edge.
 */
export function progressAlpha(
  x: number,
  filledWidth: number,
  glow: number | null,
  edge: boolean
): number {
  if (edge) return 1
  if (glow === null) return PROGRESS_ALPHA
  const center = -GLOW_RADIUS + glow * (filledWidth + 2 * GLOW_RADIUS)
  const distance = (x - center) / GLOW_RADIUS
  return PROGRESS_ALPHA + (1 - PROGRESS_ALPHA) * Math.exp(-distance * distance * 2)
}

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
 * behind them, the speaker timeline at the bottom and a thin playhead. A processing progress fills
 * the bars up to it below the played part (`WaveformProgress`).
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
  const count = barCount(width)
  const filled = drawing.progress ? filledBars(width, drawing.progress.percent) : 0
  const center = barArea / 2
  for (let index = 0; index < count; index++) {
    const peak = peaks[Math.floor((index / count) * peaks.length)] ?? 0
    const barHeight = Math.max(2, peak * (barArea - 2))
    const x = index * BAR_STEP
    // Played before filled: the playhead's part stays at full strength while the file processes.
    const played = x + BAR / 2 <= progressX
    context.fillStyle = played || index < filled ? colors.played : colors.unplayed
    if (!played && index < filled) {
      context.globalAlpha = progressAlpha(
        x,
        filled * BAR_STEP,
        drawing.progress?.glow ?? null,
        index === filled - 1
      )
    }
    context.beginPath()
    context.roundRect(x, center - barHeight / 2, BAR, barHeight, BAR / 2)
    context.fill()
    context.globalAlpha = 1
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
