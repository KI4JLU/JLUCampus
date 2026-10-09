import { describe, expect, it } from 'vitest'
import { TRANSCRIPTION_SPEAKER_COLORS } from '@justcampus/shared'
import {
  barFill,
  barSpeakerColors,
  drawWaveform,
  segmentTitle,
  timeToX,
  UNPLAYED_SPEAKER_ALPHA,
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
  it('draws the played half of the bars in the played colour', () => {
    const { context, fills } = recordingContext()
    drawWaveform(context, base)
    const bars = fills.slice(0, 10)
    expect(bars.filter((fill) => fill === 'played')).toHaveLength(5)
    expect(bars.filter((fill) => fill === 'unplayed')).toHaveLength(5)
  })

  it('draws the region first, over the full height', () => {
    const { context, fills, rects } = recordingContext()
    drawWaveform(context, { ...base, time: 0, region: { start: 2, end: 4 } })
    expect(fills[0]).toBe('region')
    expect(rects[0]).toEqual([12, 0, 12, 40])
  })

  it("draws a speaker's bars in its colour, played full and dimmed ahead, without a strip", () => {
    const { context, fills, alphas, rects } = recordingContext()
    drawWaveform(context, {
      ...base,
      segments: [
        { start: 0, end: 3, colorId: 1 },
        { start: 3, end: 7, colorId: 2 },
        { start: 7, end: 10, colorId: null }
      ]
    })
    const blue = TRANSCRIPTION_SPEAKER_COLORS[1]
    const purple = TRANSCRIPTION_SPEAKER_COLORS[2]
    // Bar centres at 0.25 s, 1.25 s, ... 9.25 s; 5 of 10 s played.
    expect(fills.slice(0, 10)).toEqual([
      blue,
      blue,
      blue,
      purple,
      purple,
      purple,
      purple,
      'unplayed',
      'unplayed',
      'unplayed'
    ])
    expect(alphas.slice(0, 10)).toEqual([
      1,
      1,
      1,
      1,
      1,
      UNPLAYED_SPEAKER_ALPHA,
      UNPLAYED_SPEAKER_ALPHA,
      1,
      1,
      1
    ])
    // Only the playhead is a rectangle: no timeline strip under the bars.
    expect(rects).toEqual([[29.5, 0, 1, 40]])
  })

  it('draws bars without segments as before: played and unplayed only', () => {
    const { context, fills, alphas } = recordingContext()
    drawWaveform(context, base)
    expect(new Set(fills.slice(0, 10))).toEqual(new Set(['played', 'unplayed']))
    expect(alphas.every((alpha) => alpha === 1)).toBe(true)
  })
})

describe('barSpeakerColors', () => {
  const speakers = TRANSCRIPTION_SPEAKER_COLORS

  it('gives each bar the colour of the stretch at its centre, null in gaps and neutral stretches', () => {
    // 60 px over 10 s: ten bars, centres at 0.25 s, 1.25 s, ... 9.25 s.
    expect(
      barSpeakerColors(
        [
          { start: 0, end: 2, colorId: 3 },
          { start: 2.5, end: 4, colorId: null },
          { start: 5, end: 10, colorId: 4 }
        ],
        10,
        60,
        speakers
      )
    ).toEqual([
      speakers[3],
      speakers[3],
      null,
      null,
      null,
      speakers[4],
      speakers[4],
      speakers[4],
      speakers[4],
      speakers[4]
    ])
  })

  it('takes the stretches in any order, a stretch ending where the next starts', () => {
    expect(
      barSpeakerColors(
        [
          { start: 5, end: 10, colorId: 2 },
          { start: 0, end: 5, colorId: 1 }
        ],
        10,
        60,
        speakers
      )
    ).toEqual([...Array<string>(5).fill(speakers[1]), ...Array<string>(5).fill(speakers[2])])
  })

  it('keeps every bar neutral while the duration is unknown or without stretches', () => {
    expect(barSpeakerColors([{ start: 0, end: 5, colorId: 1 }], 0, 60, speakers)).toEqual(
      Array<null>(10).fill(null)
    )
    expect(barSpeakerColors([], 10, 60, speakers)).toEqual(Array<null>(10).fill(null))
  })
})

describe('barFill', () => {
  const tokens = { played: 'played', unplayed: 'unplayed' }

  it("draws a speaker's bar at full strength once played and dimmed ahead of the playhead", () => {
    expect(barFill('#3b82f6', true, tokens)).toEqual({ color: '#3b82f6', alpha: 1 })
    expect(barFill('#3b82f6', false, tokens)).toEqual({
      color: '#3b82f6',
      alpha: UNPLAYED_SPEAKER_ALPHA
    })
    expect(UNPLAYED_SPEAKER_ALPHA).toBeLessThan(1)
  })

  it('keeps the neutral colours for a bar without a speaker', () => {
    expect(barFill(null, true, tokens)).toEqual({ color: 'played', alpha: 1 })
    expect(barFill(null, false, tokens)).toEqual({ color: 'unplayed', alpha: 1 })
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
