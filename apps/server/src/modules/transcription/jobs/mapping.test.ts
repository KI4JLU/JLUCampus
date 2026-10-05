import type { TranscriptionSegment, TranscriptionWord } from '@justcampus/shared'
import { describe, expect, it } from 'vitest'

import type { DiarizationTurn } from './diarization.js'
import { endsWithPunctuation, joinWords, mapDiarizationSegments } from './mapping.js'

/**
 * Fixtures worked through kiChat's `CustomSpeachesProvider::mapDiarizationSegments` by hand: the
 * expected values are what the PHP code gives for the same input.
 */

function segment(id: number, start: number, end: number, text: string): TranscriptionSegment {
  return { id, start, end, text, speaker: null, redactions: [], avgLogprob: -0.1, seek: id }
}

function word(start: number, end: number, text: string): TranscriptionWord {
  return { start, end, word: text, probability: 0.9 }
}

type Brief = Pick<TranscriptionSegment, 'id' | 'start' | 'end' | 'text' | 'speaker'>

const brief = (segments: TranscriptionSegment[]): Brief[] =>
  segments.map(({ id, start, end, text, speaker }) => ({ id, start, end, text, speaker }))

describe('punctuation and words', () => {
  it('looks at the last character past quotes and spaces', () => {
    expect(endsWithPunctuation(' Ende.')).toBe(true)
    expect(endsWithPunctuation('„Wirklich?“')).toBe(true)
    expect(endsWithPunctuation('Komma,')).toBe(false)
    expect(endsWithPunctuation(' »« ')).toBe(false)
  })

  it('joins Whisper words by their own spaces, others with spaces', () => {
    expect(joinWords([{ word: ' Guten' }, { word: ' Tag.' }])).toBe('Guten Tag.')
    expect(joinWords([{ word: 'Guten' }, { word: 'Tag.' }])).toBe('Guten Tag.')
  })
})

describe('mapDiarizationSegments without word timing (the HRZ gateway)', () => {
  const turns: DiarizationTurn[] = [
    { start: 0.03, end: 7.9, speaker: 'SPEAKER_00' },
    { start: 8.05, end: 15.9, speaker: 'SPEAKER_01' }
  ]
  const segments = [
    segment(1, 0, 4, 'Guten Tag.'),
    segment(2, 4, 8, 'Wie geht es Ihnen?'),
    segment(3, 8, 10, 'Gut.'),
    segment(4, 10, 14, 'Danke der Nachfrage.')
  ]

  it('gives each segment the voice overlapping it most and merges one voice’s run', () => {
    const mapped = mapDiarizationSegments({ segments, words: [] }, turns, {
      speakerMapping: { SPEAKER_00: 'Anna' }
    })
    expect(brief(mapped.segments)).toEqual([
      { id: 1, start: 0, end: 8, text: 'Guten Tag. Wie geht es Ihnen?', speaker: 'Anna' },
      // Not named by the user: the next `Stimme N` after the mapping's one name.
      { id: 2, start: 8, end: 14, text: 'Gut. Danke der Nachfrage.', speaker: 'Stimme 2' }
    ])
    // The merged segment keeps its first part's decoder fields.
    expect(mapped.segments[1]).toMatchObject({ avgLogprob: -0.1, seek: 3 })
    expect(mapped.words).toEqual([])
  })

  it('keeps a name the diariser recognised as a known voice', () => {
    const known: DiarizationTurn[] = [
      { start: 0, end: 7.9, speaker: 'Carla' },
      { start: 8.05, end: 15.9, speaker: 'SPEAKER_01' }
    ]
    const mapped = mapDiarizationSegments({ segments, words: [] }, known, {
      knownSpeakerNames: ['Carla']
    })
    expect(mapped.segments.map((value) => value.speaker)).toEqual(['Carla', 'Stimme 1'])
  })

  it('counts past the mapping’s numbered names', () => {
    const mapped = mapDiarizationSegments({ segments, words: [] }, turns, {
      speakerMapping: { SPEAKER_07: 'Sprecher 3' }
    })
    expect(mapped.segments.map((value) => value.speaker)).toEqual(['Stimme 4', 'Stimme 5'])
  })

  it('leaves speech no voice covers unknown and does not merge across 3 s or a pause', () => {
    const mapped = mapDiarizationSegments(
      {
        segments: [
          segment(1, 0, 2, 'Eins.'),
          segment(2, 2.2, 3, 'Zwei'),
          segment(3, 3.5, 4, 'drei'),
          segment(4, 20, 22, 'Rauschen'),
          segment(5, 25.5, 26, 'vier'),
          segment(6, 29.5, 30, 'fünf')
        ],
        words: []
      },
      [
        { start: 0, end: 5, speaker: 'SPEAKER_00' },
        { start: 25, end: 30, speaker: 'SPEAKER_00' }
      ]
    )
    expect(brief(mapped.segments)).toEqual([
      // A sentence end followed by a pause of 0.10 s or more keeps the segments apart.
      { id: 1, start: 0, end: 2, text: 'Eins.', speaker: 'Stimme 1' },
      { id: 2, start: 2.2, end: 4, text: 'Zwei drei', speaker: 'Stimme 1' },
      { id: 3, start: 20, end: 22, text: 'Rauschen', speaker: null },
      { id: 4, start: 25.5, end: 26, text: 'vier', speaker: 'Stimme 1' },
      // 3.5 s apart: not merged.
      { id: 5, start: 29.5, end: 30, text: 'fünf', speaker: 'Stimme 1' }
    ])
  })

  it('changes nothing without turns', () => {
    const mapped = mapDiarizationSegments({ segments, words: [] }, [])
    expect(mapped.segments).toEqual(segments)
  })
})

describe('mapDiarizationSegments with word timing (Speaches)', () => {
  it('splits a segment where the voice changes after a sentence', () => {
    const words = [
      word(0, 0.5, ' Hallo'),
      word(0.5, 1, ' Ben.'),
      word(1.2, 1.7, ' Hallo'),
      word(1.7, 2.2, ' Anna.')
    ]
    const mapped = mapDiarizationSegments(
      { segments: [segment(1, 0, 6, 'Hallo Ben. Hallo Anna.')], words },
      [
        { start: 0, end: 1.05, speaker: 'SPEAKER_00' },
        { start: 1.1, end: 3, speaker: 'SPEAKER_01' }
      ],
      { speakerMapping: { SPEAKER_01: 'Ben' } }
    )
    expect(brief(mapped.segments)).toEqual([
      { id: 1, start: 0, end: 1, text: 'Hallo Ben.', speaker: 'Stimme 2' },
      { id: 2, start: 1.2, end: 2.2, text: 'Hallo Anna.', speaker: 'Ben' }
    ])
    expect(mapped.words.map((value) => value.speaker)).toEqual([
      'Stimme 2',
      'Stimme 2',
      'Ben',
      'Ben'
    ])
    expect(mapped.segments[0]).not.toHaveProperty('words')
  })

  it('weighs a phrase’s later words more', () => {
    // No pause and no sentence end: one phrase. Each word overlaps one voice fully; the later
    // word counts twice, so the phrase goes to its voice.
    const mapped = mapDiarizationSegments(
      {
        segments: [segment(1, 0, 2, 'ja genau')],
        words: [word(0, 1, ' ja'), word(1, 2, ' genau')]
      },
      [
        { start: 0, end: 1, speaker: 'A' },
        { start: 1, end: 2.5, speaker: 'B' }
      ],
      { speakerMapping: { A: 'Anna', B: 'Ben' } }
    )
    expect(brief(mapped.segments)).toEqual([
      { id: 1, start: 0, end: 2, text: 'ja genau', speaker: 'Ben' }
    ])
  })

  it('fills a phrase between turns from the VAD region it lies in', () => {
    const input = {
      segments: [segment(1, 0, 4, 'Guten Tag.'), segment(2, 5, 5.5, 'Ja.')],
      words: [word(0, 0.6, ' Guten'), word(0.6, 1.2, ' Tag.'), word(5, 5.5, ' Ja.')]
    }
    const turns: DiarizationTurn[] = [
      { start: 0, end: 4, speaker: 'A' },
      { start: 6, end: 9, speaker: 'B' }
    ]
    const withVad = mapDiarizationSegments(input, turns, {
      speakerMapping: { A: 'Anna', B: 'Ben' },
      vadSegments: [{ start: 4.5, end: 6.5 }]
    })
    expect(withVad.segments.map((value) => value.speaker)).toEqual(['Anna', 'Ben'])
    const without = mapDiarizationSegments(input, turns, {
      speakerMapping: { A: 'Anna', B: 'Ben' }
    })
    expect(without.segments.map((value) => value.speaker)).toEqual(['Anna', null])
    expect(without.words.at(-1)!.speaker).toBeNull()
  })
})
