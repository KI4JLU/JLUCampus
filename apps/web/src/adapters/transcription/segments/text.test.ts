import { describe, expect, it } from 'vitest'
import { TRANSCRIPTION_EMPTY_SPEAKER_TEXT } from '@justcampus/shared'
import { buildSpeakerBlocks } from './blocks'
import { speakerLabel } from './labels'
import {
  buildTranscriptText,
  formatTimestamp,
  isPlaceholder,
  joinTexts,
  needsSpace,
  sanitizeSegmentText
} from './text'
import { seg } from './test-fixtures'
import { sourceIndexAt, sourceTimeline, toGlobalTime, toLocalTime, totalDuration } from './timeline'
import { popUndo, pushUndo, type EditSnapshot } from './undo'

describe('text helpers', () => {
  it('spaces texts like kiChat', () => {
    expect(needsSpace('Hallo', 'Welt')).toBe(true)
    expect(needsSpace('Hallo ', 'Welt')).toBe(false)
    expect(needsSpace('Hallo', ', Welt')).toBe(false)
    expect(joinTexts(['  Eins', 'zwei', ' drei', '.'])).toBe('Eins zwei drei.')
  })

  it('formats block timestamps as hh:mm:ss', () => {
    expect(formatTimestamp(0)).toBe('00:00:00')
    expect(formatTimestamp(3725.9)).toBe('01:02:05')
    expect(formatTimestamp(Number.NaN)).toBe('00:00:00')
  })

  it('recognises the placeholder and strips line breaks', () => {
    expect(isPlaceholder(` ${TRANSCRIPTION_EMPTY_SPEAKER_TEXT} `)).toBe(true)
    expect(sanitizeSegmentText('a\nb\r\nc d')).toBe('abc d')
  })

  it('builds the plain transcript text by speaker turns and pauses', () => {
    const segments = [
      seg(0, 0, 1, 'Hallo', 'Anna'),
      seg(1, 1, 2, 'zusammen.', 'Anna'),
      seg(2, 5, 6, 'Nach der Pause.', 'Anna'),
      seg(3, 6, 7, TRANSCRIPTION_EMPTY_SPEAKER_TEXT, 'Ben'),
      seg(4, 7, 8, 'Ohne Namen.')
    ]
    expect(buildTranscriptText(segments)).toBe(
      'Anna: Hallo zusammen.\n\nAnna: Nach der Pause.\n\nOhne Namen.'
    )
  })
})

describe('speakerLabel', () => {
  const labels = { unknown: (n: number) => `Unknown ${n}`, voice: (n: number) => `Voice ${n}` }

  it('localises automatic names and keeps typed ones', () => {
    expect(speakerLabel('Unbekannt 2', labels)).toBe('Unknown 2')
    expect(speakerLabel('Stimme 3', labels)).toBe('Voice 3')
    expect(speakerLabel('Speaker 1', labels)).toBe('Voice 1')
    expect(speakerLabel('Stimme', labels)).toBe('Stimme')
    expect(speakerLabel('Prof. Müller', labels)).toBe('Prof. Müller')
  })
})

describe('timeline of several files', () => {
  const sources = [
    { jobId: null, name: 'a.wav', size: 1, duration: 10, startTime: 0, endTime: 10 },
    { jobId: null, name: 'b.wav', size: 1, duration: 5, startTime: 10, endTime: 15 }
  ]

  it('maps global to local time and back', () => {
    expect(sourceIndexAt(sources, 3)).toBe(0)
    expect(sourceIndexAt(sources, 10)).toBe(1)
    expect(sourceIndexAt(sources, 99)).toBe(1)
    expect(sourceIndexAt([], 1)).toBe(-1)
    expect(toLocalTime(sources[1]!, 12.5)).toBe(2.5)
    expect(toLocalTime(sources[1]!, 4)).toBe(0)
    expect(toGlobalTime(sources[1]!, 2.5)).toBe(12.5)
  })

  it('clips the speaker time line to one file', () => {
    const { blocks } = buildSpeakerBlocks(
      [seg(0, 0, 8, 'a', 'A'), seg(1, 8, 12, 'b', 'B'), seg(2, 12, 15, 'c', 'A')],
      {}
    )
    expect(sourceTimeline(blocks, sources[1]!)).toEqual([
      { start: 0, end: 2, colorId: 2 },
      { start: 2, end: 5, colorId: 1 }
    ])
    expect(sourceTimeline(blocks, null)).toHaveLength(3)
    expect(totalDuration(sources, blocks, null)).toBe(15)
    expect(totalDuration([], blocks, null)).toBe(15)
    expect(totalDuration([], [], 7)).toBe(7)
  })
})

describe('undo stack', () => {
  const snapshot = (n: number): EditSnapshot => ({
    segments: [seg(n, 0, 1, String(n))],
    speakerColors: {}
  })

  it('keeps the last ten snapshots', () => {
    let stack = pushUndo([], snapshot(0))
    for (let index = 1; index < 12; index++) stack = pushUndo(stack, snapshot(index))
    expect(stack).toHaveLength(10)
    expect(stack[0]!.segments[0]!.id).toBe(2)
    const popped = popUndo(stack)!
    expect(popped.snapshot.segments[0]!.id).toBe(11)
    expect(popped.stack).toHaveLength(9)
    expect(popUndo([])).toBeNull()
  })
})
