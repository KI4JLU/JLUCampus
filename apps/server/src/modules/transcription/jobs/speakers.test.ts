import { describe, expect, it } from 'vitest'

import {
  automaticVoice,
  automaticVoiceName,
  normalizeTurns,
  sampleWindow,
  speakersFromTurns,
  type SpeakerTurn
} from './speakers.js'

/** Two voices taking turns every eight seconds over 24 seconds. */
const turns: SpeakerTurn[] = normalizeTurns(
  [
    { start: 0.03, end: 7.9, speaker: 'spk_a' },
    { start: 8.05, end: 15.9, speaker: 'spk_b' },
    { start: 16.05, end: 24, speaker: 'spk_a' }
  ],
  24
)

describe('normalizeTurns', () => {
  it('renames voices by first appearance and clips turns to the media', () => {
    expect(
      normalizeTurns(
        [
          { start: 5, end: 9, speaker: 'zeta' },
          { start: 1, end: 3, speaker: 'alpha' },
          { start: 8, end: 30, speaker: 'alpha' },
          { start: 4, end: 4, speaker: 'empty' },
          { start: Number.NaN, end: 2, speaker: 'broken' }
        ],
        10
      )
    ).toEqual([
      { start: 1, end: 3, speaker: 'SPEAKER_00' },
      { start: 5, end: 9, speaker: 'SPEAKER_01' },
      { start: 8, end: 10, speaker: 'SPEAKER_00' }
    ])
  })
})

describe('speakersFromTurns', () => {
  it('lists voices by first appearance with localisable labels and samples', () => {
    const speakers = speakersFromTurns(turns, 24)
    expect(
      speakers.map(({ id, index, label, start, end }) => ({ id, index, label, start, end }))
    ).toEqual([
      { id: 'SPEAKER_00', index: 0, label: 'Stimme 1', start: 0.03, end: 24 },
      { id: 'SPEAKER_01', index: 1, label: 'Stimme 2', start: 8.05, end: 15.9 }
    ])
    // Samples come from the longest turns, at most five seconds each, in time order.
    expect(speakers[0]!.samples).toEqual([
      { id: 'SPEAKER_00-1', start: 0.03, end: 5.03 },
      { id: 'SPEAKER_00-2', start: 16.05, end: 21.05 }
    ])
    expect(speakers[1]!.samples).toEqual([{ id: 'SPEAKER_01-1', start: 8.05, end: 13.05 }])
  })

  it('stretches a very short turn to the minimum sample within the media', () => {
    expect(sampleWindow({ start: 9.95, end: 10 }, 10)).toEqual({ start: 9.8, end: 10 })
    expect(sampleWindow({ start: 2, end: 2.05 }, null)).toEqual({ start: 2, end: 2.2 })
  })

  it('offers up to five samples per voice from its longest turns, as kiChat', () => {
    const many = normalizeTurns(
      Array.from({ length: 7 }, (_, index) => ({
        start: index * 10,
        end: index * 10 + 1 + index,
        speaker: 'A'
      })),
      80
    )
    const [voice] = speakersFromTurns(many, 80)
    expect(voice!.samples.map((sample) => sample.start)).toEqual([20, 30, 40, 50, 60])
    expect(voice!.samples.at(-1)).toMatchObject({ start: 60, end: 65 })
  })

  it('offers no voices without turns', () => {
    expect(speakersFromTurns([], 10)).toEqual([])
  })
})

describe('automatic voice', () => {
  it('is one voice over the whole file without samples', () => {
    expect(automaticVoice(12.345)).toEqual({
      id: 'SPEAKER_00',
      index: 0,
      label: 'Stimme 1',
      start: 0,
      end: 12.35,
      samples: []
    })
  })

  it('takes the name the user gave it, else its label', () => {
    expect(automaticVoiceName({ SPEAKER_00: ' Anna ' }, [])).toBe('Anna')
    expect(automaticVoiceName({}, [{ id: 'SPEAKER_00', name: 'Ben', start: 0, end: 1 }])).toBe(
      'Ben'
    )
    expect(automaticVoiceName({ SPEAKER_01: 'Other' }, [])).toBe('Stimme 1')
  })
})
