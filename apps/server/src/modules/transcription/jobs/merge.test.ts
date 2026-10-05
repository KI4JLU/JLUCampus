import { describe, expect, it } from 'vitest'

import type { AsrResult } from './asr.js'
import { joinText, mergeChunks, planChunks } from './merge.js'

function recognition(
  segments: Array<[start: number, end: number, text: string]>,
  language: string | null = 'de'
): AsrResult {
  return {
    text: segments.map(([, , text]) => text).join(' '),
    language,
    duration: null,
    segments: segments.map(([start, end, text]) => ({
      start,
      end,
      text,
      seek: 0,
      tokens: [1, 2, 3],
      temperature: 0,
      avgLogprob: -0.1,
      compressionRatio: 1,
      noSpeechProb: 0.01
    })),
    words: []
  }
}

describe('planChunks', () => {
  it('cuts back to back without overlap', () => {
    expect(planChunks(25, 10)).toEqual([
      { index: 0, start: 0, end: 10 },
      { index: 1, start: 10, end: 20 },
      { index: 2, start: 20, end: 25 }
    ])
  })

  it('adds a very short tail to the chunk before', () => {
    expect(planChunks(1203, 600)).toEqual([
      { index: 0, start: 0, end: 600 },
      { index: 1, start: 600, end: 1203 }
    ])
  })

  it('keeps a short file in one chunk', () => {
    expect(planChunks(11.240544, 600)).toEqual([{ index: 0, start: 0, end: 11.240544 }])
  })
})

describe('mergeChunks', () => {
  it('offsets every chunk by its start, so timing runs on monotonically', () => {
    const merged = mergeChunks([
      // Given out of order: the merge follows the chunks' places.
      {
        plan: { index: 1, start: 600, end: 1200 },
        result: recognition([
          [0, 4.5, 'Dritter.'],
          [4.5, 9, 'Vierter.']
        ])
      },
      {
        plan: { index: 0, start: 0, end: 600 },
        result: recognition([
          [0, 5, 'Erster.'],
          [5, 601, 'Zweiter.']
        ])
      }
    ])
    expect(merged.segments.map(({ id, start, end, text }) => ({ id, start, end, text }))).toEqual([
      { id: 1, start: 0, end: 5, text: 'Erster.' },
      // A segment running past its chunk ends with it.
      { id: 2, start: 5, end: 600, text: 'Zweiter.' },
      { id: 3, start: 600, end: 604.5, text: 'Dritter.' },
      { id: 4, start: 604.5, end: 609, text: 'Vierter.' }
    ])
    const starts = merged.segments.map((segment) => segment.start)
    expect([...starts].sort((a, b) => a - b)).toEqual(starts)
    expect(merged.text).toBe('Erster. Zweiter. Dritter. Vierter.')
    expect(merged.segments[0]).toMatchObject({
      speaker: null,
      redactions: [],
      tokens: [1, 2, 3],
      avgLogprob: -0.1,
      noSpeechProb: 0.01
    })
  })

  it('offsets words too and takes the language most chunks detected', () => {
    const first = recognition([[0, 1, 'Hallo.']], 'de')
    first.words = [{ start: 0.2, end: 0.6, word: 'Hallo', probability: 0.9 }]
    const merged = mergeChunks([
      { plan: { index: 0, start: 0, end: 10 }, result: first },
      { plan: { index: 1, start: 10, end: 20 }, result: recognition([[0, 1, 'Hi.']], 'en') },
      { plan: { index: 2, start: 20, end: 30 }, result: recognition([[1, 2, 'Ja.']], 'de') }
    ])
    expect(merged.words).toEqual([{ start: 0.2, end: 0.6, word: 'Hallo', probability: 0.9 }])
    expect(merged.language).toBe('de')
    expect(merged.segments.at(-1)).toMatchObject({ start: 21, end: 22 })
  })

  it('joins text with single spaces, leaving out empty segments', () => {
    expect(joinText([{ text: ' Ja. ' }, { text: '' }, { text: 'Nein.' }])).toBe('Ja. Nein.')
  })
})
