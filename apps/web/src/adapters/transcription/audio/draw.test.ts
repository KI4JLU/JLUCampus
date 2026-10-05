import { describe, expect, it } from 'vitest'
import { TRANSCRIPTION_SPEAKER_COLORS } from '@justcampus/shared'
import { drawWaveform, timeToX, type WaveformDrawing } from './draw'

/** A canvas context that records what is filled with which colour. */
function recordingContext(): {
  context: CanvasRenderingContext2D
  fills: string[]
  rects: number[][]
} {
  const fills: string[] = []
  const rects: number[][] = []
  let fillStyle = ''
  const context = {
    clearRect: () => {},
    beginPath: () => {},
    roundRect: () => {},
    fill: () => fills.push(fillStyle),
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
  return { context: context as unknown as CanvasRenderingContext2D, fills, rects }
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
