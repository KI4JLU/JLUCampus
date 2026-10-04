import { describe, expect, it } from 'vitest'
import {
  blockAt,
  blockSpeakers,
  buildSpeakerBlocks,
  isSoloed,
  revealSpeaker,
  materializeSpeakers,
  toggleSolo,
  unknownSpeakerNumber
} from './blocks'
import { seg } from './test-fixtures'

describe('buildSpeakerBlocks', () => {
  it('groups consecutive segments of one named speaker', () => {
    const segments = [
      seg(0, 0, 2, 'Hallo', 'Anna'),
      seg(1, 2, 4, 'wie geht es?', 'Anna'),
      seg(2, 10, 12, 'Gut.', 'Ben'),
      seg(3, 12, 14, 'Und dir?', 'Anna')
    ]
    const { blocks } = buildSpeakerBlocks(segments, {})
    expect(blocks.map((block) => [block.speaker, block.segmentIndices])).toEqual([
      ['Anna', [0, 1]],
      ['Ben', [2]],
      ['Anna', [3]]
    ])
    expect(blocks[0]).toMatchObject({ start: 0, end: 4, text: 'Hallo wie geht es?' })
  })

  it('splits stretches without a speaker after a gap over 3 s or a span over 45 s', () => {
    const segments = [
      seg(0, 0, 1, 'a'),
      seg(1, 4, 5, 'b'), // gap of exactly 3 s: same block
      seg(2, 8.5, 9, 'c'), // gap 3.5 s: new block
      seg(3, 9, 20, 'd'),
      seg(4, 20, 40, 'e'),
      seg(5, 40, 54, 'f'), // 31.5 s after the block start: same block
      seg(6, 54, 56, 'g') // 45.5 s after the block start: new block
    ]
    const { blocks } = buildSpeakerBlocks(segments, {})
    expect(blocks.map((block) => [block.speaker, block.segmentIndices])).toEqual([
      ['Unbekannt 1', [0, 1]],
      ['Unbekannt 2', [2, 3, 4, 5]],
      ['Unbekannt 3', [6]]
    ])
    expect(blocks.map((block) => block.unknown)).toEqual([1, 2, 3])
  })

  it('lets segments without a speaker continue a named block, as kiChat does', () => {
    const { blocks } = buildSpeakerBlocks(
      [seg(0, 0, 1, 'Ja', 'Anna'), seg(1, 1.5, 2, 'genau'), seg(2, 9, 10, 'später')],
      {}
    )
    expect(blocks.map((block) => [block.speaker, block.segmentIndices])).toEqual([
      ['Anna', [0, 1]],
      ['Unbekannt 1', [2]]
    ])
  })

  it('gives new speakers the next of ten colours and keeps stored ones', () => {
    const names = Array.from({ length: 12 }, (_, index) => `S${index}`)
    const segments = names.map((name, index) => seg(index, index, index + 1, 'x', name))
    const { blocks, speakerColors } = buildSpeakerBlocks(segments, {
      S0: { colorId: 7, speakerIndex: 0 }
    })
    expect(blocks[0]!.colorId).toBe(7)
    expect(blocks.slice(1).map((block) => block.colorId)).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10, 1, 2
    ])
    expect(speakerColors.S11).toEqual({ colorId: 2, speakerIndex: 11 })
  })

  it('returns the same colour map when every speaker has a colour', () => {
    const colors = { Anna: { colorId: 3 as const, speakerIndex: 0 } }
    expect(buildSpeakerBlocks([seg(0, 0, 1, 'x', 'Anna')], colors).speakerColors).toBe(colors)
  })

  it('joins texts without a space before punctuation', () => {
    const { blocks } = buildSpeakerBlocks(
      [seg(0, 0, 1, ' Hallo', 'A'), seg(1, 1, 2, ', Welt', 'A'), seg(2, 2, 3, ' !', 'A')],
      {}
    )
    expect(blocks[0]!.text).toBe('Hallo, Welt !')
  })

  it('has no blocks without segments', () => {
    expect(buildSpeakerBlocks([], {}).blocks).toEqual([])
  })
})

describe('speaker helpers', () => {
  const segments = [
    seg(0, 0, 2, 'a', 'Anna'),
    seg(1, 2, 4, 'b'),
    seg(2, 9, 10, 'c', 'Ben'),
    seg(3, 10, 11, 'd', 'Anna')
  ]
  const { blocks } = buildSpeakerBlocks(segments, {})

  it('lists each speaker once in order', () => {
    expect(blockSpeakers(blocks).map((speaker) => [speaker.speaker, speaker.firstBlock])).toEqual([
      ['Anna', 0],
      ['Ben', 1]
    ])
  })

  it('finds the block playing at a time', () => {
    expect(blockAt(blocks, 3)).toBe(0)
    expect(blockAt(blocks, 9.5)).toBe(1)
    expect(blockAt(blocks, 6)).toBe(-1)
  })

  it('writes block speakers onto segments without one', () => {
    expect(materializeSpeakers(segments, blocks).map((segment) => segment.speaker)).toEqual([
      'Anna',
      'Anna',
      'Ben',
      'Anna'
    ])
    expect(segments[1]!.speaker).toBeNull()
  })

  it('reads automatic unknown names', () => {
    expect(unknownSpeakerNumber('Unbekannt 4')).toBe(4)
    expect(unknownSpeakerNumber('Unbekannte 4')).toBeNull()
  })

  it('solos a speaker and shows everyone again on the second toggle', () => {
    const speakers = ['Anna', 'Ben', 'Cem']
    const hidden = toggleSolo(speakers, new Set(), 'Ben')
    expect([...hidden].sort()).toEqual(['Anna', 'Cem'])
    expect(isSoloed(speakers, hidden, 'Ben')).toBe(true)
    expect(toggleSolo(speakers, hidden, 'Ben').size).toBe(0)
    expect(isSoloed(['Anna'], new Set(), 'Anna')).toBe(false)
  })

  it('shows a hidden speaker that is chosen to focus, and leaves the others hidden', () => {
    const hidden = toggleSolo(['Anna', 'Ben', 'Cem'], new Set(), 'Ben')
    expect([...revealSpeaker(hidden, 'Anna')]).toEqual(['Cem'])
    expect(revealSpeaker(hidden, 'Ben')).toBe(hidden)
  })
})
