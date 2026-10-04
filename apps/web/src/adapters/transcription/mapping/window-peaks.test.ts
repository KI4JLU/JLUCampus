import { describe, expect, it } from 'vitest'
import { peaksBetween, timePeaksOf } from './window-peaks'

describe('timePeaksOf', () => {
  it('takes the loudest sample per bucket of time, scaled to the loudest', () => {
    // 1 second at 100 Hz, 20 peaks per second: buckets of 5 samples.
    const channel = new Float32Array(100)
    channel[2] = 0.5
    channel[7] = -1
    channel[99] = 0.25
    const peaks = timePeaksOf(channel, 100, 20)
    expect(peaks).toHaveLength(20)
    expect(peaks[0]).toBeCloseTo(0.5)
    expect(peaks[1]).toBeCloseTo(1)
    expect(peaks[19]).toBeCloseTo(0.25)
    expect(peaks[10]).toBe(0)
  })

  it('stays finite for silence', () => {
    expect(timePeaksOf(new Float32Array(10), 10, 5)).toEqual([0, 0, 0, 0, 0])
  })
})

describe('peaksBetween', () => {
  it('slices the peaks of a time range, at least one', () => {
    const data = { peaks: [0, 0.1, 0.2, 0.3, 0.4, 0.5], duration: 3 }
    expect(peaksBetween(data, 0.5, 1.5, 2)).toEqual([0.1, 0.2])
    expect(peaksBetween(data, 10, 12, 2)).toEqual([0])
  })
})
