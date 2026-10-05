import { describe, expect, it } from 'vitest'
import { TRANSCRIPTION_EMPTY_SPEAKER_TEXT } from '@justcampus/shared'
import { buildSpeakerBlocks } from './blocks'
import {
  blockCopyText,
  clearRedactions,
  listRedactions,
  mergeRedactions,
  redactSelection,
  redactedText,
  removeRedaction,
  textPieces,
  truncateRedaction
} from './redaction'
import { seg } from './test-fixtures'

describe('mergeRedactions', () => {
  it('sorts and merges touching and overlapping ranges', () => {
    expect(
      mergeRedactions([
        { start: 10, end: 12 },
        { start: 0, end: 3 },
        { start: 3, end: 5 },
        { start: 11, end: 15 },
        { start: 20, end: 21 }
      ])
    ).toEqual([
      { start: 0, end: 5 },
      { start: 10, end: 15 },
      { start: 20, end: 21 }
    ])
  })
})

describe('redactSelection', () => {
  const segments = [seg(0, 0, 1, 'Mein Name ist Anna.', 'A'), seg(1, 1, 2, ' Ich wohne hier.', 'A')]

  it('redacts the selected part without surrounding blanks', () => {
    const result = redactSelection(segments, {
      start: { segment: 0, offset: 13 },
      end: { segment: 0, offset: 19 }
    })!
    expect(result[0]!.redactions).toEqual([{ start: 14, end: 19 }])
    expect(result[0]!.text).toBe(segments[0]!.text)
  })

  it('redacts across segments and merges with existing ranges', () => {
    const start = [{ ...segments[0]!, redactions: [{ start: 0, end: 7 }] }, segments[1]!]
    const result = redactSelection(start, {
      start: { segment: 0, offset: 5 },
      end: { segment: 1, offset: 4 }
    })!
    expect(result[0]!.redactions).toEqual([{ start: 0, end: 19 }])
    expect(result[1]!.redactions).toEqual([{ start: 1, end: 4 }])
  })

  it('rejects blank and missing selections', () => {
    expect(
      redactSelection(segments, {
        start: { segment: 1, offset: 0 },
        end: { segment: 1, offset: 1 }
      })
    ).toBeNull()
    expect(redactSelection(segments, null)).toBeNull()
  })
})

describe('removing redactions', () => {
  const segments = [
    seg(0, 0, 1, 'abcdef', 'A', {
      redactions: [
        { start: 0, end: 1 },
        { start: 3, end: 4 }
      ]
    }),
    seg(1, 1, 2, 'xyz', 'B')
  ]

  it('removes one', () => {
    expect(removeRedaction(segments, 0, 1)![0]!.redactions).toEqual([{ start: 0, end: 1 }])
    expect(removeRedaction(segments, 1, 0)).toBeNull()
  })

  it('clears all without touching the text', () => {
    const result = clearRedactions(segments)!
    expect(result.map((segment) => segment.redactions)).toEqual([[], []])
    expect(result[0]!.text).toBe('abcdef')
    expect(clearRedactions(result)).toBeNull()
  })
})

describe('listRedactions', () => {
  it('lists every range with its speaker and cuts long texts to 57 characters', () => {
    const long = 'x'.repeat(61)
    const segments = [
      seg(0, 0, 1, `ab ${long}`, null, {
        redactions: [
          { start: 0, end: 2 },
          { start: 3, end: 64 }
        ]
      })
    ]
    const entries = listRedactions(segments)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ segment: 0, redaction: 0, speaker: null, display: 'ab' })
    expect(entries[1]!.display).toBe(`${'x'.repeat(57)}...`)
  })

  it('keeps texts of exactly 60 characters', () => {
    expect(truncateRedaction('y'.repeat(60))).toBe('y'.repeat(60))
  })
})

describe('textPieces and redactedText', () => {
  it('cuts a text into shown and concealed pieces', () => {
    expect(
      textPieces('Hallo Anna, wie', [
        { start: 6, end: 10 },
        { start: 13, end: 40 }
      ])
    ).toEqual([
      { redacted: false, start: 0, end: 6, text: 'Hallo ' },
      { redacted: true, start: 6, end: 10, text: 'Anna' },
      { redacted: false, start: 10, end: 13, text: ', w' },
      { redacted: true, start: 13, end: 15, text: 'ie' }
    ])
    expect(textPieces('', [])).toEqual([{ redacted: false, start: 0, end: 0, text: '' }])
  })

  it('replaces redacted ranges with the export marker', () => {
    expect(redactedText('Hallo Anna!', [{ start: 6, end: 10 }])).toBe('Hallo [AUSGEBLENDET]!')
  })
})

describe('blockCopyText', () => {
  it('copies the block with redactions replaced and the placeholder hint', () => {
    const segments = [
      seg(0, 0, 1, 'Ich bin Anna.', 'A', { redactions: [{ start: 8, end: 12 }] }),
      seg(1, 1, 2, TRANSCRIPTION_EMPTY_SPEAKER_TEXT, 'A')
    ]
    const block = buildSpeakerBlocks(segments, {}).blocks[0]!
    expect(blockCopyText(segments, block, '[This speaker has no text yet!]')).toBe(
      'Ich bin [AUSGEBLENDET]. [This speaker has no text yet!]'
    )
  })
})
