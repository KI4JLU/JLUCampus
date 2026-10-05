import { describe, expect, it } from 'vitest'

import {
  germanDate,
  minutesText,
  participants,
  participantsOfText,
  placeholderValues,
  plainText,
  redactedText,
  speakerText
} from './text.js'

const segment = (
  start: number,
  end: number,
  speaker: string | null,
  text: string,
  redactions: Array<{ start: number; end: number }> = []
): {
  start: number
  end: number
  speaker: string | null
  text: string
  redactions: Array<{ start: number; end: number }>
} => ({ start, end, speaker, text, redactions })

describe('redactedText', () => {
  it('replaces each range, in any order, and trims', () => {
    expect(
      redactedText({
        text: ' Herr Meier wohnt in Gießen. ',
        redactions: [
          { start: 21, end: 27 },
          { start: 1, end: 11 }
        ]
      })
    ).toBe('[AUSGEBLENDET] wohnt in [AUSGEBLENDET].')
  })

  it('gives overlapping and touching ranges one marker', () => {
    expect(
      redactedText({
        text: 'abcdefgh',
        redactions: [
          { start: 1, end: 4 },
          { start: 3, end: 6 }
        ]
      })
    ).toBe('a[AUSGEBLENDET]gh')
    expect(
      redactedText({
        text: 'abcdefgh',
        redactions: [
          { start: 0, end: 2 },
          { start: 2, end: 3 }
        ]
      })
    ).toBe('[AUSGEBLENDET]defgh')
    expect(redactedText({ text: 'Klartext', redactions: [] })).toBe('Klartext')
  })
})

describe('speakerText', () => {
  it('joins a speaker’s segments into one turn and starts another after ten seconds', () => {
    const text = speakerText([
      segment(0, 2, 'Anna', 'Hallo.'),
      segment(2, 4, 'Anna', 'Wie geht es?'),
      segment(4, 6, 'Ben', 'Gut.', [{ start: 0, end: 3 }]),
      segment(17, 18, 'Ben', 'Später.'),
      segment(18, 19, null, 'Wer war das?')
    ])
    expect(text).toBe(
      'Anna: Hallo. Wie geht es?\nBen: [AUSGEBLENDET].\nBen: Später.\nUnbekannt: Wer war das?'
    )
  })

  it('is empty without segments', () => {
    expect(speakerText([])).toBe('')
  })
})

describe('participants and placeholders', () => {
  it('lists named speakers in order of appearance', () => {
    expect(
      participants([{ speaker: 'Ben' }, { speaker: null }, { speaker: 'Anna' }, { speaker: 'Ben' }])
    ).toEqual(['Ben', 'Anna'])
    expect(participantsOfText('Anna: Hallo\nUnbekannt: x\nBen: Tag\nkein Sprecher')).toEqual([
      'Anna',
      'Ben'
    ])
  })

  it('formats dates and durations as kiChat', () => {
    expect(germanDate(new Date('2026-10-04T22:30:00Z'))).toBe('05.10.2026')
    expect(minutesText(2700)).toBe('45 Min')
    expect(minutesText(null)).toBe('–')
    // Campus: under a minute is `< 1 Min`, where kiChat says `0 Min`.
    expect(minutesText(0)).toBe('< 1 Min')
    expect(minutesText(42)).toBe('< 1 Min')
    expect(minutesText(60)).toBe('1 Min')
    expect(
      placeholderValues({
        title: 'T',
        date: new Date('2026-10-04T10:00:00Z'),
        participants: [],
        duration: 90
      })
    ).toEqual({ title: 'T', date: '04.10.2026', participants: 'Unbekannt', duration: '2 Min' })
  })

  it('keeps the plain text unredacted', () => {
    expect(plainText([{ text: ' Eins. ' }, { text: '' }, { text: 'Zwei.' }])).toBe('Eins. Zwei.')
  })
})
