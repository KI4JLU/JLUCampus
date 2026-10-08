import { windowView, type TimeWindow } from './speakers'
import { PEAKS_PER_SECOND, type TimePeaks } from './window-peaks'

/**
 * The time scale of the sample editor's track, after kiChat's `getZoomMetrics`: the track always
 * covers the whole file, the window takes a tenth of its width, and the stretches before and after
 * it share the rest by their length. So one click or one drag reaches any point of a long file,
 * while the window itself stays wide enough to trim. While the audio's length is unknown the track
 * shows the stretch around the window (`windowView`) at an even scale instead.
 */

/** The share of the track the window takes (kiChat's `EDITOR_ZOOM_WIDTH`). */
export const WINDOW_SHARE = 0.1

/** The placeholder bar height while there are no peaks. */
const PLACEHOLDER_PEAK = 0.45

export interface TrackScale {
  /** The first and last second the track shows. */
  start: number
  end: number
  /** Where a time lies on the track, from 0 to 1. */
  toFraction: (seconds: number) => number
  /** The time at a place on the track, from 0 to 1. */
  toTime: (fraction: number) => number
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

/** An even scale over `view`. */
function linearScale(view: TimeWindow): TrackScale {
  const span = Math.max(0.001, view.end - view.start)
  return {
    start: view.start,
    end: view.end,
    toFraction: (seconds) => clamp01((seconds - view.start) / span),
    toTime: (fraction) => view.start + clamp01(fraction) * span
  }
}

/**
 * The track's scale for a window: kiChat's three parts over the whole file, or an even scale over
 * the stretch around the window while the length is unknown.
 */
export function trackScale(window: TimeWindow, duration: number | null): TrackScale {
  if (duration === null || !Number.isFinite(duration) || duration <= 0) {
    return linearScale(windowView(window, duration))
  }
  const total = duration
  const zoomStart = Math.max(0, Math.min(window.start, total))
  const zoomEnd = Math.max(zoomStart, Math.min(window.end, total))
  const before = zoomStart
  const inside = Math.max(0.001, zoomEnd - zoomStart)
  const after = Math.max(0, total - zoomEnd)
  // The window covering the whole file takes the whole track.
  const zoomWidth = before + after > 0 ? WINDOW_SHARE : 1
  const preEnd = before + after > 0 ? (1 - zoomWidth) * (before / (before + after)) : 0
  const zoomEndAt = preEnd + zoomWidth

  return {
    start: 0,
    end: total,
    toFraction: (seconds) => {
      if (seconds <= zoomStart) return before > 0 ? (Math.max(0, seconds) / before) * preEnd : 0
      if (seconds <= zoomEnd) return preEnd + ((seconds - zoomStart) / inside) * zoomWidth
      const progress = after > 0 ? Math.min(1, (seconds - zoomEnd) / after) : 0
      return zoomEndAt + progress * (1 - zoomEndAt)
    },
    toTime: (fraction) => {
      const at = clamp01(fraction)
      if (at <= preEnd) return preEnd > 0 ? (at / preEnd) * before : 0
      if (at <= zoomEndAt) return zoomStart + ((at - preEnd) / zoomWidth) * inside
      const progress = zoomEndAt < 1 ? (at - zoomEndAt) / (1 - zoomEndAt) : 0
      return zoomEnd + progress * after
    }
  }
}

/**
 * One peak per bar of the track: the loudest over the time the bar covers, as kiChat's editor
 * draws it (a bar inside the window covers milliseconds, one beside it maybe minutes). `step` is
 * the distance from one bar to the next in pixels; placeholder bars without peaks.
 */
export function trackBarPeaks(
  scale: TrackScale,
  data: TimePeaks | null,
  width: number,
  step: number,
  perSecond: number = PEAKS_PER_SECOND
): number[] {
  const count = Math.max(1, Math.floor(width / step))
  if (!data || data.peaks.length === 0) return new Array<number>(count).fill(PLACEHOLDER_PEAK)
  const last = data.peaks.length - 1
  const bars = new Array<number>(count).fill(0)
  for (let bar = 0; bar < count; bar++) {
    const from = scale.toTime((bar * step) / width)
    const to = scale.toTime(((bar + 1) * step) / width)
    const first = Math.floor(from * perSecond)
    if (first > last) continue
    const end = Math.min(last, Math.max(first, Math.ceil(to * perSecond) - 1))
    let peak = 0
    for (let index = Math.max(0, first); index <= end; index++) {
      peak = Math.max(peak, data.peaks[index] ?? 0)
    }
    bars[bar] = peak
  }
  return bars
}
