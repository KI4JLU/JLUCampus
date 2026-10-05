import { describe, expect, it } from 'vitest'
import type { TranscriptionResult, TranscriptionSegment } from '@justcampus/shared'
import { mergeResults, resultDuration, speakerColorsFor, transcriptCreate } from './merge'

function segment(
  id: number,
  start: number,
  end: number,
  text: string,
  speaker: string | null = 'Ada'
): TranscriptionSegment {
  return { id, start, end, text, speaker, redactions: [] }
}

function result(change: Partial<TranscriptionResult>): TranscriptionResult {
  return {
    text: '',
    language: 'de',
    duration: null,
    segments: [],
    words: [],
    model: 'jlu/whisper-1',
    provider: 'KI@JLU',
    ...change
  }
}

const round = (value: number): number => Math.round(value * 100) / 100

const first = result({
  text: 'Guten Tag.',
  duration: 11.24,
  segments: [
    {
      ...segment(1, 0, 10.72, 'Guten Tag.'),
      avgLogprob: -0.05,
      tokens: [1, 2],
      words: [{ start: 0, end: 0.5, word: 'Guten' }]
    }
  ],
  words: [{ start: 0, end: 0.5, word: 'Guten' }]
})
const second = result({
  text: 'Vielen Dank.',
  language: 'en',
  duration: null,
  segments: [segment(0, 0.5, 2, 'Vielen'), segment(1, 2, 4.4, 'Dank.', 'Bo')],
  words: [{ start: 2, end: 2.4, word: 'Dank' }]
})

describe('resultDuration', () => {
  it('takes the duration, else the last segment end, else 0', () => {
    expect(resultDuration(first)).toBe(11.24)
    expect(resultDuration(second)).toBe(4.4)
    expect(resultDuration(result({}))).toBe(0)
  })
})

describe('mergeResults (T-14)', () => {
  const merged = mergeResults([
    { name: 'a.wav', size: 100, jobId: 'job-a', result: first },
    { name: 'b.wav', size: 50, jobId: 'job-b', result: second }
  ])

  it('shifts later segments and words by what came before, in file order', () => {
    expect(merged.segments.map((entry) => [round(entry.start), round(entry.end)])).toEqual([
      [0, 10.72],
      [11.74, 13.24],
      [13.24, 15.64]
    ])
    expect(merged.words.map((word) => round(word.start))).toEqual([0, 13.24])
    for (let index = 1; index < merged.segments.length; index++) {
      expect(merged.segments[index]!.start).toBeGreaterThanOrEqual(merged.segments[index - 1]!.end)
    }
  })

  it('keeps ids unique and decoder fields, shifting words inside segments', () => {
    expect(merged.segments.map((entry) => entry.id)).toEqual([1, 2, 3])
    expect(merged.segments[0]).toMatchObject({ avgLogprob: -0.05, tokens: [1, 2] })
    expect(merged.segments[0]?.words?.[0]?.start).toBe(0)
  })

  it('records where each file lies and rounds the total', () => {
    expect(
      merged.sourceFiles.map((source) => ({ ...source, endTime: round(source.endTime) }))
    ).toEqual([
      { jobId: 'job-a', name: 'a.wav', size: 100, duration: 11.24, startTime: 0, endTime: 11.24 },
      { jobId: 'job-b', name: 'b.wav', size: 50, duration: 4.4, startTime: 11.24, endTime: 15.64 }
    ])
    expect(merged.duration).toBe(16)
    expect(merged.text).toBe('Guten Tag. Vielen Dank.')
    expect(merged.language).toBe('de')
  })

  it('leaves a single file as it is', () => {
    const single = mergeResults([{ name: 'a.wav', size: 1, jobId: null, result: first }])
    expect(single.segments).toEqual(first.segments)
    expect(single.duration).toBe(11)
  })
})

describe('the save request', () => {
  it('colours speakers by the mapping, else by order of appearance', () => {
    const colors = speakerColorsFor(
      [segment(0, 0, 1, 'x', 'Bo'), segment(1, 1, 2, 'y', null), segment(2, 2, 3, 'z', 'Ada')],
      new Map([['Ada', 9 as const]])
    )
    expect(colors).toEqual({
      Bo: { colorId: 1, speakerIndex: 0 },
      Ada: { colorId: 9, speakerIndex: 1 }
    })
  })

  it('names the group and its jobs in queue order', () => {
    const input = transcriptCreate({
      idempotencyKey: '00000000-0000-4000-8000-000000000000',
      title: '  Interview  ',
      files: [
        { name: 'a.wav', size: 1, jobId: 'job-a', result: first },
        { name: 'b.wav', size: 1, jobId: 'job-b', result: second }
      ],
      chosenColors: new Map()
    })
    expect(input).toMatchObject({ title: 'Interview', jobIds: ['job-a', 'job-b'], duration: 16 })
    expect(Object.keys(input.speakerColors ?? {})).toEqual(['Ada', 'Bo'])
  })
})
