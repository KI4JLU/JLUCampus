import type { TranscriptionSpeakerColorId } from '@justcampus/shared'
import { formatTime } from './peaks'

/** The colours a waveform is drawn in, from the design tokens and the speaker palette. */
export interface WaveformColors {
  played: string
  unplayed: string
  region: string
  /** The bars of a speaker's stretch, played at full strength and dimmed ahead of the playhead. */
  speakers: Record<TranscriptionSpeakerColorId, string>
}

/** A stretch of the audio one speaker talks in; its bars are drawn in the speaker's colour. */
export interface WaveformSpeakerStretch {
  start: number
  end: number
  colorId: TranscriptionSpeakerColorId | null
}

export interface WaveformDrawing {
  width: number
  height: number
  peaks: readonly number[]
  /** Seconds; 0 while unknown, which draws everything unplayed. */
  duration: number
  time: number
  /** Speakers' stretches, in seconds; `colorId: null` and the gaps keep the neutral bars. */
  segments: readonly WaveformSpeakerStretch[]
  region: { start: number; end: number } | null
  colors: WaveformColors
}

/** Bar width and gap, as in kiChat's player. */
const BAR = 3
const GAP = 3
/** Pixels from one bar to the next; one peak per bar is drawn as is. */
export const BAR_STEP = BAR + GAP
/** Strength of a speaker's bars ahead of the playhead, so the played ones still stand out. */
export const UNPLAYED_SPEAKER_ALPHA = 0.4

/** How many bars fit the width; one at least. */
export function barCount(width: number): number {
  return Math.max(1, Math.floor(width / BAR_STEP))
}

/** The x position of a time, or 0 while the duration is unknown. */
export function timeToX(seconds: number, duration: number, width: number): number {
  if (duration <= 0) return 0
  return (Math.min(Math.max(seconds, 0), duration) / duration) * width
}

/**
 * Each bar's speaker colour: that of the stretch at the bar's centre, `null` where no stretch with
 * a colour is, which keeps the bar neutral; all `null` while the duration is unknown.
 */
export function barSpeakerColors(
  segments: readonly WaveformSpeakerStretch[],
  duration: number,
  width: number,
  speakers: Record<TranscriptionSpeakerColorId, string>
): (string | null)[] {
  const count = barCount(width)
  const colors = Array<string | null>(count).fill(null)
  if (duration <= 0 || segments.length === 0) return colors
  // One sweep over the stretches by start, as the bars go left to right: a long transcript has
  // many stretches, and this runs on every frame while playing.
  const sorted = [...segments].sort((a, b) => a.start - b.start)
  let next = 0
  for (let index = 0; index < count; index++) {
    const time = ((index * BAR_STEP + BAR / 2) / width) * duration
    while (next < sorted.length && sorted[next]!.end <= time) next++
    const stretch = sorted[next]
    if (stretch && stretch.start <= time && stretch.colorId !== null) {
      colors[index] = speakers[stretch.colorId]
    }
  }
  return colors
}

/**
 * How one bar is filled: played in the speaker's colour or the played colour at full strength;
 * ahead of the playhead the speaker's colour dimmed, or the unplayed colour for a bar without a
 * speaker.
 */
export function barFill(
  speaker: string | null,
  played: boolean,
  colors: Pick<WaveformColors, 'played' | 'unplayed'>
): { color: string; alpha: number } {
  if (played) return { color: speaker ?? colors.played, alpha: 1 }
  return speaker
    ? { color: speaker, alpha: UNPLAYED_SPEAKER_ALPHA }
    : { color: colors.unplayed, alpha: 1 }
}

/**
 * The hover text of a speaker's stretch at a time, kiChat's global player title:
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
 * behind them and a thin playhead. A speaker's stretch draws its bars in the speaker's colour
 * (`barFill`).
 */
export function drawWaveform(context: CanvasRenderingContext2D, drawing: WaveformDrawing): void {
  const { width, height, peaks, duration, time, segments, region, colors } = drawing
  context.clearRect(0, 0, width, height)

  if (region && duration > 0) {
    const start = timeToX(region.start, duration, width)
    context.fillStyle = colors.region
    context.fillRect(start, 0, Math.max(1, timeToX(region.end, duration, width) - start), height)
  }

  const progressX = timeToX(time, duration, width)
  const count = barCount(width)
  const speakers = barSpeakerColors(segments, duration, width, colors.speakers)
  const center = height / 2
  for (let index = 0; index < count; index++) {
    const peak = peaks[Math.floor((index / count) * peaks.length)] ?? 0
    const barHeight = Math.max(2, peak * (height - 2))
    const x = index * BAR_STEP
    const fill = barFill(speakers[index] ?? null, x + BAR / 2 <= progressX, colors)
    context.fillStyle = fill.color
    context.globalAlpha = fill.alpha
    context.beginPath()
    context.roundRect(x, center - barHeight / 2, BAR, barHeight, BAR / 2)
    context.fill()
    context.globalAlpha = 1
  }

  if (progressX > 0) {
    context.fillStyle = colors.played
    context.fillRect(progressX - 0.5, 0, 1, height)
  }
}
