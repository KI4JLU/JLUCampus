import { describe, expect, it } from 'vitest'
import { TRANSCRIPTION_EMPTY_SPEAKER_TEXT } from '@justcampus/shared'
import { buildSpeakerBlocks, type SpeakerBlock } from './blocks'
import {
  applyOptimizedSpeakers,
  cleanupOrphanedPlaceholders,
  insertOptions,
  insertSpeakerBlock,
  moveSelection,
  moveSelectionEdge,
  moveTarget,
  nextSegmentId,
  normalizeSelection,
  reassignBlock,
  reassignOptions,
  removeBlockSpeaker,
  renameSpeaker,
  setSpeakerColor,
  splitSegment,
  stepTextPoint,
  updateSegmentText
} from './edit'
import { seg } from './test-fixtures'

const PLACEHOLDER = TRANSCRIPTION_EMPTY_SPEAKER_TEXT

function blocksOf(segments: Parameters<typeof buildSpeakerBlocks>[0]): SpeakerBlock[] {
  return buildSpeakerBlocks(segments, {}).blocks
}

describe('updateSegmentText', () => {
  const segments = [
    seg(0, 0, 1, 'Hallo Welt', 'A', { redactions: [{ start: 0, end: 5 }], avgLogprob: -0.2 })
  ]

  it('removes line breaks, clears redactions and keeps decoder fields', () => {
    const result = updateSegmentText(segments, 0, 'Hallo\nliebe\r\nWelt')!
    expect(result[0]!.text).toBe('HalloliebeWelt')
    expect(result[0]!.redactions).toEqual([])
    expect(result[0]!.avgLogprob).toBe(-0.2)
    expect(segments[0]!.text).toBe('Hallo Welt')
  })

  it('turns empty text into the placeholder', () => {
    expect(updateSegmentText(segments, 0, '  \n ')![0]!.text).toBe(PLACEHOLDER)
  })

  it('changes nothing for the same text or a missing segment', () => {
    expect(updateSegmentText(segments, 0, 'Hallo Welt')).toBeNull()
    expect(updateSegmentText(segments, 3, 'x')).toBeNull()
  })
})

describe('renameSpeaker and colours', () => {
  const segments = [seg(0, 0, 1, 'a', 'Anna'), seg(1, 1, 2, 'b', 'Ben'), seg(2, 2, 3, 'c', 'Anna')]
  const colors = {
    Anna: { colorId: 4 as const, speakerIndex: 0 },
    Ben: { colorId: 2 as const, speakerIndex: 1 }
  }

  it('renames every segment and moves the colour', () => {
    const result = renameSpeaker(segments, colors, 'Anna', ' Anja ')!
    expect(result.segments.map((segment) => segment.speaker)).toEqual(['Anja', 'Ben', 'Anja'])
    expect(result.speakerColors).toEqual({
      Anja: { colorId: 4, speakerIndex: 0 },
      Ben: { colorId: 2, speakerIndex: 1 }
    })
  })

  it('keeps the colour of an existing name when merging', () => {
    const result = renameSpeaker(segments, colors, 'Anna', 'Ben')!
    expect(result.speakerColors).toEqual({ Ben: { colorId: 2, speakerIndex: 1 } })
  })

  it('names an automatic block through its segments', () => {
    const result = renameSpeaker(
      [seg(0, 0, 1, 'a'), seg(1, 9, 10, 'b')],
      {},
      'Unbekannt 1',
      'Cem',
      [0]
    )!
    expect(result.segments.map((segment) => segment.speaker)).toEqual(['Cem', null])
  })

  it('refuses empty or unchanged names', () => {
    expect(renameSpeaker(segments, colors, 'Anna', '  ')).toBeNull()
    expect(renameSpeaker(segments, colors, 'Anna', 'Anna')).toBeNull()
  })

  it('sets a colour', () => {
    expect(setSpeakerColor(colors, 'Ben', 9)).toEqual({
      ...colors,
      Ben: { colorId: 9, speakerIndex: 1 }
    })
    expect(setSpeakerColor(colors, 'Ben', 2)).toBeNull()
    expect(setSpeakerColor({}, 'Neu', 5)).toEqual({ Neu: { colorId: 5, speakerIndex: 0 } })
  })
})

describe('reassign and remove a block speaker', () => {
  const segments = [
    seg(0, 0, 1, 'a', 'Anna', { avgLogprob: -0.1 }),
    seg(1, 1, 2, 'b', 'Ben'),
    seg(2, 2, 3, PLACEHOLDER, 'Ben'),
    seg(3, 3, 4, 'd', 'Cem')
  ]
  const blocks = blocksOf(segments)

  it('reassigns a block, keeping text and times', () => {
    const result = reassignBlock(segments, blocks[0]!, 'Neu')!
    expect(result[0]).toEqual({ ...segments[0], speaker: 'Neu' })
    expect(reassignBlock(segments, blocks[0]!, 'Anna')).toBeNull()
  })

  it('merges a removed block into the one before and drops its placeholders', () => {
    const result = removeBlockSpeaker(segments, blocks, 1)!
    expect(result.map((segment) => [segment.text, segment.speaker])).toEqual([
      ['a', 'Anna'],
      ['b', 'Anna'],
      ['d', 'Cem']
    ])
  })

  it('merges the first block into the next', () => {
    const result = removeBlockSpeaker(segments, blocks, 0)!
    expect(result[0]!.speaker).toBe('Ben')
  })

  it('refuses to remove the only block', () => {
    const single = [seg(0, 0, 1, 'a', 'Anna')]
    expect(removeBlockSpeaker(single, blocksOf(single), 0)).toBeNull()
  })

  it('offers the other speakers', () => {
    expect(reassignOptions(blocks, blocks[1]!)).toEqual(['Anna', 'Cem'])
    expect(insertOptions([seg(0, 0, 1, 'x'), ...segments], blocks[0]!)).toEqual([
      'Person 1',
      'Ben',
      'Cem'
    ])
  })
})

describe('insertSpeakerBlock', () => {
  const segments = [seg(0, 0, 2, 'a', 'Anna'), seg(5, 2, 4, 'b', 'Anna'), seg(1, 6, 8, 'c', 'Ben')]
  const blocks = blocksOf(segments)

  it('inserts a placeholder of one second above a block', () => {
    const result = insertSpeakerBlock(segments, blocks, 1, 'above', 'Cem')!
    expect(result[2]).toMatchObject({ id: 6, start: 6, end: 7, text: PLACEHOLDER, speaker: 'Cem' })
    expect(result.filter((segment) => segment.text !== PLACEHOLDER)).toEqual(segments)
  })

  it('inserts below a block at its end', () => {
    const result = insertSpeakerBlock(segments, blocks, 0, 'below', 'Cem')!
    expect(result.map((segment) => segment.text)).toEqual(['a', 'b', PLACEHOLDER, 'c'])
    expect(result[2]).toMatchObject({ start: 4, end: 5 })
  })

  it('names stretches without a speaker before inserting', () => {
    const plain = [seg(0, 0, 1, 'a'), seg(1, 10, 11, 'b')]
    const result = insertSpeakerBlock(plain, blocksOf(plain), 1, 'below', 'Cem')!
    expect(result.map((segment) => segment.speaker)).toEqual(['Unbekannt 1', 'Unbekannt 2', 'Cem'])
  })
})

describe('cleanupOrphanedPlaceholders', () => {
  it('drops placeholders next to real text of the same speaker', () => {
    const segments = [
      seg(0, 0, 1, PLACEHOLDER, 'Anna'),
      seg(1, 1, 2, 'Text', 'Anna'),
      seg(2, 2, 3, PLACEHOLDER, 'Ben'),
      seg(3, 3, 4, PLACEHOLDER, 'Ben')
    ]
    expect(cleanupOrphanedPlaceholders(segments)!.map((segment) => segment.id)).toEqual([1, 2])
  })

  it('changes nothing for a placeholder alone', () => {
    const segments = [seg(0, 0, 1, PLACEHOLDER, 'Anna'), seg(1, 1, 2, 'x', 'Ben')]
    expect(cleanupOrphanedPlaceholders(segments)).toBeNull()
  })
})

describe('splitSegment', () => {
  it('splits text, time, words and redactions in proportion', () => {
    const segment = seg(3, 10, 20, 'abcdefghij', 'A', {
      redactions: [{ start: 2, end: 7 }],
      words: [
        { start: 10, end: 13, word: 'abc' },
        { start: 15, end: 20, word: 'fghij' }
      ],
      tokens: [1, 2, 3],
      avgLogprob: -0.3
    })
    const [first, second] = splitSegment(segment, 4, 9)
    expect(first).toMatchObject({ id: 3, text: 'abcd', start: 10, end: 14, tokens: [1, 2, 3] })
    expect(first.redactions).toEqual([{ start: 2, end: 4 }])
    expect(first.words).toEqual([{ start: 10, end: 13, word: 'abc' }])
    expect(second).toMatchObject({ id: 9, text: 'efghij', start: 14, end: 20, avgLogprob: -0.3 })
    expect(second.redactions).toEqual([{ start: 0, end: 3 }])
    expect(second.words).toEqual([{ start: 15, end: 20, word: 'fghij' }])
    expect(second.tokens).toBeUndefined()
  })
})

describe('moveSelection', () => {
  const segments = [
    seg(0, 0, 10, 'Erster Satz.', 'Anna'),
    seg(1, 10, 20, 'Hallo du da.', 'Ben'),
    seg(2, 20, 30, 'Zweiter Satz.', 'Ben'),
    seg(3, 30, 40, 'Ende.', 'Cem')
  ]
  const blocks = blocksOf(segments)

  it('moves a selection inside one segment up, splitting it in three', () => {
    const bounds = { start: { segment: 1, offset: 6 }, end: { segment: 1, offset: 8 } }
    expect(moveTarget(segments, blocks, bounds, 'up')).toBe('Anna')
    const result = moveSelection(segments, blocks, bounds, 'up')!
    expect(result.map((segment) => [segment.text, segment.speaker])).toEqual([
      ['Erster Satz.', 'Anna'],
      ['Hallo ', 'Ben'],
      ['du', 'Anna'],
      [' da.', 'Ben'],
      ['Zweiter Satz.', 'Ben'],
      ['Ende.', 'Cem']
    ])
    expect(result.map((segment) => segment.text).join('')).toBe(
      segments.map((segment) => segment.text).join('')
    )
    const [hallo, du, da] = result.slice(1, 4)
    const splitEnd = 10 + 10 * (8 / 12)
    expect(hallo!.start).toBe(10)
    expect(hallo!.end).toBeCloseTo(15)
    expect(du!.start).toBeCloseTo(15)
    expect(du!.end).toBeCloseTo(splitEnd)
    expect(da!.start).toBeCloseTo(splitEnd)
    expect(da!.end).toBe(20)
    expect(new Set(result.map((segment) => segment.id)).size).toBe(result.length)
  })

  it('moves a selection over two segments down to the next speaker', () => {
    const bounds = { start: { segment: 1, offset: 6 }, end: { segment: 2, offset: 13 } }
    const result = moveSelection(segments, blocks, bounds, 'down')!
    expect(result.map((segment) => [segment.text, segment.speaker])).toEqual([
      ['Erster Satz.', 'Anna'],
      ['Hallo ', 'Ben'],
      ['du da.', 'Cem'],
      ['Zweiter Satz.', 'Cem'],
      ['Ende.', 'Cem']
    ])
  })

  it('rejects no selection, an empty one and a direction without another speaker', () => {
    expect(moveSelection(segments, blocks, null, 'up')).toBeNull()
    const empty = { start: { segment: 1, offset: 3 }, end: { segment: 1, offset: 3 } }
    expect(moveSelection(segments, blocks, empty, 'up')).toBeNull()
    const first = { start: { segment: 0, offset: 0 }, end: { segment: 0, offset: 6 } }
    expect(moveTarget(segments, blocks, first, 'up')).toBeNull()
    expect(moveSelection(segments, blocks, first, 'up')).toBeNull()
  })

  it('does not take segments a selection only touches', () => {
    const bounds = { start: { segment: 1, offset: 12 }, end: { segment: 2, offset: 0 } }
    expect(normalizeSelection(segments, bounds)).toBeNull()
    const touching = { start: { segment: 1, offset: 12 }, end: { segment: 2, offset: 7 } }
    expect(normalizeSelection(segments, touching)).toEqual({
      start: { segment: 2, offset: 0 },
      end: { segment: 2, offset: 7 }
    })
  })
})

describe('nextSegmentId', () => {
  it('takes the number after the highest id', () => {
    expect(nextSegmentId([seg(4, 0, 1, 'a'), seg(2, 1, 2, 'b')])).toBe(5)
    expect(nextSegmentId([])).toBe(0)
  })
})

describe('applyOptimizedSpeakers', () => {
  const sent = [
    seg(0, 0, 5, 'One', 'Anna'),
    seg(1, 5, 10, 'Two', 'Ben'),
    seg(2, 10, 12, 'Three', 'Ben')
  ]

  it('takes only the speakers, by id, for segments still as sent', () => {
    const current = [
      { ...sent[0]!, text: 'Changed' },
      sent[1]!,
      { ...sent[2]!, redactions: [{ start: 0, end: 2 }] }
    ]
    const answered = sent.map((segment) => ({ ...segment, speaker: 'Cem', text: 'model text' }))
    const result = applyOptimizedSpeakers(current, sent, answered)!
    expect(result[0]).toBe(current[0])
    expect(result[1]).toEqual({ ...sent[1], speaker: 'Cem' })
    expect(result[2]).toEqual({ ...current[2], speaker: 'Cem' })
  })

  it('ignores segments that are new or gone, and answers null without a change', () => {
    const current = [sent[0]!, seg(7, 5, 6, 'New', 'Ben')]
    expect(applyOptimizedSpeakers(current, sent, sent)).toBeNull()
    expect(applyOptimizedSpeakers(current, sent, [{ id: 7, speaker: 'Anna' }])).toBeNull()
  })
})

describe('selection handles', () => {
  const segments = [seg(0, 0, 5, 'Hello there', 'Anna'), seg(1, 5, 9, 'and more', 'Anna')]
  const block = { segmentIndices: [0, 1] }
  const bounds = { start: { segment: 0, offset: 6 }, end: { segment: 0, offset: 11 } }

  it('moves one edge and keeps the other, within the block', () => {
    expect(moveSelectionEdge(segments, block, bounds, 'start', { segment: 0, offset: 0 })).toEqual({
      start: { segment: 0, offset: 0 },
      end: { segment: 0, offset: 11 }
    })
    expect(moveSelectionEdge(segments, block, bounds, 'end', { segment: 1, offset: 3 })).toEqual({
      start: { segment: 0, offset: 6 },
      end: { segment: 1, offset: 3 }
    })
  })

  it('refuses points outside the block and edges that meet or cross', () => {
    expect(
      moveSelectionEdge(segments, { segmentIndices: [0] }, bounds, 'end', { segment: 1, offset: 3 })
    ).toBeNull()
    expect(
      moveSelectionEdge(segments, block, bounds, 'start', { segment: 0, offset: 11 })
    ).toBeNull()
    expect(moveSelectionEdge(segments, block, bounds, 'end', { segment: 0, offset: 2 })).toBeNull()
  })

  it('steps a character at a time, over segment boundaries, not out of the block', () => {
    expect(stepTextPoint(segments, block, { segment: 0, offset: 6 }, -1)).toEqual({
      segment: 0,
      offset: 5
    })
    expect(stepTextPoint(segments, block, { segment: 0, offset: 11 }, 1)).toEqual({
      segment: 1,
      offset: 1
    })
    expect(stepTextPoint(segments, block, { segment: 1, offset: 0 }, -1)).toEqual({
      segment: 0,
      offset: 10
    })
    expect(stepTextPoint(segments, block, { segment: 1, offset: 8 }, 1)).toBeNull()
    expect(stepTextPoint(segments, block, { segment: 0, offset: 0 }, -1)).toBeNull()
  })
})
