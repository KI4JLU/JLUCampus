import { describe, expect, it } from 'vitest'
import { TRANSCRIPTION_SPEAKER_COLORS } from '@justcampus/shared'
import {
  BAR_STEP,
  barCount,
  drawWaveform,
  easeProgress,
  filledBars,
  PROGRESS_ALPHA,
  progressAlpha,
  segmentTitle,
  timeToX,
  type WaveformDrawing
} from './draw'

/** A canvas context that records what is filled with which colour. */
function recordingContext(): {
  context: CanvasRenderingContext2D
  fills: string[]
  alphas: number[]
  rects: number[][]
} {
  const fills: string[] = []
  const alphas: number[] = []
  const rects: number[][] = []
  let fillStyle = ''
  const context = {
    globalAlpha: 1,
    clearRect: () => {},
    beginPath: () => {},
    roundRect: () => {},
    fill: () => {
      fills.push(fillStyle)
      alphas.push(context.globalAlpha)
    },
    fillRect: (...args: number[]) => {
      fills.push(fillStyle)
      rects.push(args)
    },
    get fillStyle() {
      return fillStyle
    },
    set fillStyle(value: string) {
      fillStyle = value
    }
  }
  return { context: context as unknown as CanvasRenderingContext2D, fills, alphas, rects }
}

const colors = {
  played: 'played',
  unplayed: 'unplayed',
  region: 'region',
  neutral: 'neutral',
  speakers: TRANSCRIPTION_SPEAKER_COLORS
}

const base: WaveformDrawing = {
  width: 60,
  height: 40,
  peaks: [0.5, 1],
  duration: 10,
  time: 5,
  segments: [],
  region: null,
  colors
}

describe('timeToX', () => {
  it('clamps to the audio and is 0 while the duration is unknown', () => {
    expect(timeToX(5, 10, 100)).toBe(50)
    expect(timeToX(20, 10, 100)).toBe(100)
    expect(timeToX(5, 0, 100)).toBe(0)
  })
})

describe('drawWaveform', () => {
  it('fills the bars up to the progress below the played part', () => {
    const { context, fills, alphas } = recordingContext()
    drawWaveform(context, { ...base, time: 2, progress: { percent: 70, glow: null } })
    expect(BAR_STEP * 10).toBe(base.width)
    // 2 of 10 s played: two bars at full strength; 70 %: up to the seventh bar in the played
    // colour at half strength, the edge bar at full; three unplayed.
    expect(fills.slice(0, 10)).toEqual([
      ...Array<string>(7).fill('played'),
      ...Array<string>(3).fill('unplayed')
    ])
    expect(alphas.slice(0, 10)).toEqual([
      1,
      1,
      ...Array<number>(4).fill(PROGRESS_ALPHA),
      1,
      1,
      1,
      1
    ])
  })

  it('draws the played half of the bars in the played colour', () => {
    const { context, fills } = recordingContext()
    drawWaveform(context, base)
    const bars = fills.slice(0, 10)
    expect(bars.filter((fill) => fill === 'played')).toHaveLength(5)
    expect(bars.filter((fill) => fill === 'unplayed')).toHaveLength(5)
  })

  it('draws the region first and a timeline stretch per speaker', () => {
    const { context, fills, rects } = recordingContext()
    drawWaveform(context, {
      ...base,
      time: 0,
      region: { start: 2, end: 4 },
      segments: [
        { start: 0, end: 5, colorId: 1 },
        { start: 5, end: 10, colorId: null }
      ]
    })
    expect(fills[0]).toBe('region')
    expect(rects[0]).toEqual([12, 0, 12, 34])
    expect(fills).toContain(TRANSCRIPTION_SPEAKER_COLORS[1])
    expect(fills).toContain('neutral')
  })
})

describe('filledBars', () => {
  it('fills the bars whose centre the progress reached', () => {
    // 60 px: ten bars, centres at 1.5, 7.5, ... 55.5.
    expect(barCount(60)).toBe(10)
    expect(filledBars(60, 0)).toBe(0)
    expect(filledBars(60, 2)).toBe(0)
    expect(filledBars(60, 2.5)).toBe(1)
    expect(filledBars(60, 50)).toBe(5)
    expect(filledBars(60, 100)).toBe(10)
  })

  it('clamps the progress to 0 to 100', () => {
    expect(filledBars(60, -10)).toBe(0)
    expect(filledBars(60, 140)).toBe(10)
  })
})

describe('easeProgress', () => {
  it('moves part of the way towards the target, more the longer the frame', () => {
    const short = easeProgress(0, 40, 16)
    const long = easeProgress(0, 40, 250)
    expect(short).toBeGreaterThan(0)
    expect(short).toBeLessThan(long)
    expect(long).toBeCloseTo(40 * (1 - Math.exp(-1)))
  })

  it('lands on the target once close, and follows it down too', () => {
    expect(easeProgress(39.97, 40, 16)).toBe(40)
    expect(easeProgress(40, 40, 16)).toBe(40)
    expect(easeProgress(40, 0, 16)).toBeLessThan(40)
  })

  it('stays put for a frame without time', () => {
    expect(easeProgress(10, 40, 0)).toBe(10)
    expect(easeProgress(10, 40, -5)).toBe(10)
  })
})

describe('progressAlpha', () => {
  it('draws filled bars at half strength without a glow, the edge bar at full', () => {
    expect(progressAlpha(12, 60, null, false)).toBe(PROGRESS_ALPHA)
    expect(progressAlpha(54, 60, null, true)).toBe(1)
  })

  it('brightens the bars under the glow as it runs across', () => {
    // Halfway through its run the glow is over the middle of the filled bars.
    expect(progressAlpha(30, 60, 0.5, false)).toBeCloseTo(1)
    expect(progressAlpha(30, 60, 0, false)).toBeLessThan(0.7)
  })
})

describe('segmentTitle', () => {
  const segments = [
    { start: 0, end: 8.58, label: 'Stimme 1' },
    { start: 8.58, end: 75, label: 'Frau Becker' },
    { start: 80, end: 90 }
  ]

  it("names the speaker and range under the pointer, as kiChat's global player", () => {
    expect(segmentTitle(segments, 3)).toBe('Stimme 1: 00:00 - 00:08')
    expect(segmentTitle(segments, 8.58)).toBe('Frau Becker: 00:08 - 01:15')
  })

  it('is empty between stretches and for a stretch without a label', () => {
    expect(segmentTitle(segments, 77)).toBe('')
    expect(segmentTitle(segments, 85)).toBe('')
  })
})
