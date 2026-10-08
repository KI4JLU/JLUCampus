import { describe, expect, it } from 'vitest'
import { trackBarPeaks, trackScale, WINDOW_SHARE } from './track-scale'

const close = (value: number): number => Math.round(value * 1e6) / 1e6

describe('trackScale (kiChat getZoomMetrics)', () => {
  it('covers the whole file and gives the window a tenth of the track', () => {
    const scale = trackScale({ start: 100, end: 105 }, 600)
    expect(scale.start).toBe(0)
    expect(scale.end).toBe(600)
    // 100 s before and 495 s after share the other 90 % by their length.
    const preEnd = 0.9 * (100 / 595)
    expect(close(scale.toFraction(100))).toBe(close(preEnd))
    expect(close(scale.toFraction(105))).toBe(close(preEnd + WINDOW_SHARE))
    expect(scale.toFraction(0)).toBe(0)
    expect(scale.toFraction(600)).toBe(1)
    // A click anywhere reaches the whole file, including its far end.
    expect(scale.toTime(0)).toBe(0)
    expect(close(scale.toTime(1))).toBe(600)
    expect(close(scale.toTime(preEnd + WINDOW_SHARE / 2))).toBe(102.5)
  })

  it('maps times and places back and forth', () => {
    const scale = trackScale({ start: 12, end: 14.5 }, 28.7)
    for (const seconds of [0, 5, 12, 13.2, 14.5, 20, 28.7]) {
      expect(close(scale.toTime(scale.toFraction(seconds)))).toBe(close(seconds))
    }
  })

  it('puts a window at the start or end of the file at the track’s edge', () => {
    const first = trackScale({ start: 0, end: 5 }, 60)
    expect(first.toFraction(0)).toBe(0)
    expect(close(first.toFraction(5))).toBe(WINDOW_SHARE)
    const last = trackScale({ start: 55, end: 60 }, 60)
    expect(close(last.toFraction(55))).toBe(1 - WINDOW_SHARE)
    // A window over the whole file takes the whole track.
    const whole = trackScale({ start: 0, end: 4 }, 4)
    expect(whole.toFraction(2)).toBe(0.5)
  })

  it('shows the stretch around the window while the length is unknown', () => {
    const scale = trackScale({ start: 20, end: 25 }, null)
    expect([scale.start, scale.end]).toEqual([0, 35])
    expect(scale.toFraction(17.5)).toBe(0.5)
  })
})

describe('trackBarPeaks', () => {
  it('takes the loudest peak over the time each bar covers', () => {
    // Ten peaks per second over ten seconds; one loud moment at 8 s.
    const peaks = new Array<number>(100).fill(0.1)
    peaks[80] = 1
    const scale = trackScale({ start: 1, end: 2 }, 10)
    const bars = trackBarPeaks(scale, { peaks, duration: 10 }, 60, 6, 10)
    expect(bars).toHaveLength(10)
    // The bar after the window covers 2 s to about 2.9 s: no loud moment.
    expect(bars[1]).toBe(0.1)
    expect(bars.filter((peak) => peak === 1)).toHaveLength(1)
    expect(Math.min(...bars)).toBe(0.1)
  })

  it('draws placeholder bars without peaks', () => {
    const bars = trackBarPeaks(trackScale({ start: 0, end: 5 }, 60), null, 60, 6)
    expect(bars).toEqual(new Array(10).fill(0.45))
  })
})
