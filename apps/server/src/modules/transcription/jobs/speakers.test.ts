import type { TranscriptionSegment, TranscriptionSnippet } from '@justcampus/shared'
import { describe, expect, it } from 'vitest'

import {
  assignSpeakers,
  normalizeTurns,
  resolveSpeakerNames,
  sampleWindow,
  speakersFromTurns,
  type SpeakerTurn
} from './speakers.js'

function segment(
  id: number,
  start: number,
  end: number,
  text = `Satz ${id}`
): TranscriptionSegment {
  return { id, start, end, text, speaker: null, redactions: [], avgLogprob: -0.1 }
}

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

  it('offers no voices without turns', () => {
    expect(speakersFromTurns([], 10)).toEqual([])
  })
})

describe('resolveSpeakerNames', () => {
  const speakers = speakersFromTurns(turns, 24)

  it('names each diarised voice after the window overlapping it most', () => {
    const snippets: TranscriptionSnippet[] = [
      { id: 'SPEAKER_00', name: 'Anna', start: 0.03, end: 5.03 },
      { id: 'SPEAKER_01', name: 'Ben', start: 8.05, end: 13.05 }
    ]
    const names = resolveSpeakerNames(turns, speakers, { SPEAKER_00: 'Anna' }, snippets)
    expect(Object.fromEntries(names)).toEqual({ SPEAKER_00: 'Anna', SPEAKER_01: 'Ben' })
  })

  it('lets a voice added by hand name what the diariser heard in its window', () => {
    const snippets: TranscriptionSnippet[] = [
      { id: 'SPEAKER_00', name: 'Anna', start: 0.03, end: 5.03 },
      // The user added Carla and marked a window where SPEAKER_01 speaks.
      { id: 'MANUAL_0', name: 'Carla', start: 9, end: 12 }
    ]
    const names = resolveSpeakerNames(turns, speakers, { MANUAL_0: 'Carla' }, snippets)
    expect(names.get('SPEAKER_01')).toBe('Carla')
    expect(names.get('SPEAKER_00')).toBe('Anna')
  })

  it('follows edited windows over the id they were sent with', () => {
    // The sample of SPEAKER_01 was moved to where SPEAKER_00 speaks.
    const snippets: TranscriptionSnippet[] = [
      { id: 'SPEAKER_00', name: 'Anna', start: 1, end: 2 },
      { id: 'SPEAKER_01', name: 'Ben', start: 17, end: 21 }
    ]
    const names = resolveSpeakerNames(turns, speakers, { SPEAKER_01: 'Ben' }, snippets)
    expect(names.get('SPEAKER_00')).toBe('Ben')
    // No window touches SPEAKER_01 any more: the mapping names it.
    expect(names.get('SPEAKER_01')).toBe('Ben')
  })

  it('falls back to the mapping, then to the automatic label', () => {
    const names = resolveSpeakerNames(turns, speakers, { SPEAKER_01: '  Ben ' }, [])
    expect(Object.fromEntries(names)).toEqual({ SPEAKER_00: 'Stimme 1', SPEAKER_01: 'Ben' })
  })

  it('breaks a tie in favour of the voice named for that id', () => {
    const snippets: TranscriptionSnippet[] = [
      { id: 'MANUAL_0', name: 'Other', start: 1, end: 2 },
      { id: 'SPEAKER_00', name: 'Own', start: 3, end: 4 }
    ]
    expect(resolveSpeakerNames(turns, speakers, {}, snippets).get('SPEAKER_00')).toBe('Own')
  })
})

describe('assignSpeakers', () => {
  it('gives each segment the voice speaking most during it, text and timing untouched', () => {
    const names = new Map([
      ['SPEAKER_00', 'Anna'],
      ['SPEAKER_01', 'Ben']
    ])
    const segments = [
      segment(1, 0, 4),
      segment(2, 7, 10),
      segment(3, 15.98, 16.04),
      segment(4, 30, 31)
    ]
    const { segments: named, words } = assignSpeakers(
      segments,
      [{ start: 9, end: 9.5, word: 'Hallo' }],
      turns,
      names,
      []
    )
    expect(named.map((value) => value.speaker)).toEqual(['Anna', 'Ben', 'Anna', 'Anna'])
    const withoutSpeaker = (value: TranscriptionSegment): Omit<TranscriptionSegment, 'speaker'> =>
      Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'speaker')) as Omit<
        TranscriptionSegment,
        'speaker'
      >
    expect(named.map(withoutSpeaker)).toEqual(segments.map(withoutSpeaker))
    expect(words[0]!.speaker).toBe('Ben')
  })

  it('uses the named windows directly without diarisation, else no speaker', () => {
    const snippets: TranscriptionSnippet[] = [{ id: 'MANUAL_0', name: 'Solo', start: 0, end: 3 }]
    const { segments } = assignSpeakers(
      [segment(1, 0, 4), segment(2, 5, 8)],
      [],
      [],
      new Map(),
      snippets
    )
    expect(segments.map((value) => value.speaker)).toEqual(['Solo', null])
  })
})
