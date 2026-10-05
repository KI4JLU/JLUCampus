import { describe, expect, it } from 'vitest'
import type { TranscriptionSpeaker } from '@justcampus/shared'
import {
  clampWindow,
  formatWindowTime,
  isAutoLabel,
  localizeAutoLabel,
  localizeSampleLabel,
  manualVoice,
  moveWindowEdge,
  newSampleWindow,
  nextSampleNumber,
  orderVoices,
  parseTime,
  slideWindow,
  unidentifiedVoiceCount,
  voiceDispatch,
  voicesFromSpeakers,
  windowView,
  type VoiceDraft
} from './speakers'

const autoLabel = (n: number): string => `Voice ${n}`
const sampleLabel = (n: number): string => `Sample ${n}`
const labels = { autoLabel, sampleLabel }

function speaker(id: string, start: number, end: number, index = 0): TranscriptionSpeaker {
  return { id, index, label: null, start, end, samples: [{ id: 's0', start, end }] }
}

function voice(change: Partial<VoiceDraft> = {}): VoiceDraft {
  return {
    id: 'SPEAKER_00',
    manual: false,
    name: 'Voice 1',
    colorId: null,
    start: 0,
    end: 5,
    samples: [],
    ...change
  }
}

describe('automatic labels', () => {
  it('knows automatic labels in both languages and leaves typed names alone', () => {
    expect(isAutoLabel('Stimme 1')).toBe(true)
    expect(isAutoLabel('Speaker 12')).toBe(true)
    expect(isAutoLabel('Sprecherin')).toBe(true)
    expect(isAutoLabel('Test speaker')).toBe(false)
    expect(localizeAutoLabel('Stimme 3', 0, autoLabel)).toBe('Voice 3')
    expect(localizeAutoLabel('Sprecher', 1, autoLabel)).toBe('Voice 2')
    expect(localizeAutoLabel('Test speaker', 0, autoLabel)).toBe('Test speaker')
    expect(localizeAutoLabel('  ', 0, autoLabel)).toBe('')
  })

  it('translates automatic sample labels and keeps typed ones', () => {
    expect(localizeSampleLabel('Beispiel 2', sampleLabel)).toBe('Sample 2')
    expect(localizeSampleLabel('sample 3 ', sampleLabel)).toBe('Sample 3')
    expect(localizeSampleLabel('Lachen am Ende', sampleLabel)).toBe('Lachen am Ende')
  })

  it('counts voices without a typed name (T-17)', () => {
    const voices = [voice(), voice({ id: 'b', name: '' }), voice({ id: 'c', name: 'Ada' })]
    expect(unidentifiedVoiceCount(voices)).toBe(2)
    expect(unidentifiedVoiceCount(null)).toBe(0)
  })
})

describe('voicesFromSpeakers', () => {
  it('orders by first moment and names unnamed voices by place', () => {
    const voices = voicesFromSpeakers(
      [speaker('SPEAKER_01', 4, 9, 1), speaker('SPEAKER_00', 0.5, 3)],
      labels
    )
    expect(voices.map((entry) => entry.id)).toEqual(['SPEAKER_00', 'SPEAKER_01'])
    expect(voices.map((entry) => entry.name)).toEqual(['Voice 1', 'Voice 2'])
    expect(voices[0]?.samples).toEqual([
      { key: 'SPEAKER_00:s0', label: 'Sample 1', start: 0.5, end: 3 }
    ])
  })

  it('localises the diarisation label and keeps given names of voices found again', () => {
    const fresh = voicesFromSpeakers([{ ...speaker('A', 0, 2), label: 'Stimme 1' }], labels)
    expect(fresh[0]?.name).toBe('Voice 1')
    const kept = voicesFromSpeakers([speaker('A', 1, 2)], labels, [
      voice({ id: 'A', name: 'Ada', colorId: 4 })
    ])
    expect(kept[0]).toMatchObject({ id: 'A', name: 'Ada', colorId: 4, start: 1 })
  })

  it('keeps voices added by hand with their samples when analysed again (T-13, T-20)', () => {
    const bob = voice({
      id: 'manual_1',
      manual: true,
      name: 'Bob',
      colorId: 7,
      start: null,
      end: null,
      samples: [{ key: 'local-1', label: 'Sample 1', start: 5, end: 10 }]
    })
    const kept = voicesFromSpeakers([speaker('SPEAKER_00', 0, 2)], labels, [
      voice({ id: 'SPEAKER_00', name: 'Ada' }),
      bob
    ])
    expect(kept.map((entry) => entry.name)).toEqual(['Ada', 'Bob'])
    expect(kept[1]).toEqual(bob)
    const dispatch = voiceDispatch(kept, 30, autoLabel)
    expect(dispatch.mapping).toMatchObject({ SPEAKER_00: 'Ada', manual_1: 'Bob' })
    expect(dispatch.snippets).toContainEqual({ id: 'manual_1', name: 'Bob', start: 5, end: 10 })
    // Without `previous` (the dialog's Repeat analysis) only the analysed voices come.
    expect(voicesFromSpeakers([speaker('SPEAKER_00', 0, 2)], labels)).toHaveLength(1)
  })

  it('puts voices added by hand last (T-18, T-20)', () => {
    const manual = voice({ id: 'manual_1', manual: true, start: null, end: null })
    const ordered = orderVoices([
      manual,
      voice({ id: 'b', start: 3 }),
      voice({ id: 'a', start: 1 })
    ])
    expect(ordered.map((entry) => entry.id)).toEqual(['a', 'b', 'manual_1'])
  })

  it('gives an added voice a unique id and the next label', () => {
    const first = manualVoice([voice()], autoLabel, 42)
    expect(first).toMatchObject({ id: 'manual_42', manual: true, name: 'Voice 2', samples: [] })
    const second = manualVoice([voice(), first], autoLabel, 42)
    expect(second.id).toBe('manual_42_1')
  })
})

describe('sample windows (T-19)', () => {
  it('keeps a window between 0.2 and 5 seconds and slides it at the maximum', () => {
    const window = { start: 10, end: 12 }
    expect(moveWindowEdge(window, 'end', 10.05, 60)).toEqual({ start: 10, end: 10.2 })
    expect(moveWindowEdge(window, 'start', 11.95, 60)).toEqual({ start: 11.8, end: 12 })
    // Pulling the end past five seconds drags the start along.
    expect(moveWindowEdge(window, 'end', 18, 60)).toEqual({ start: 13, end: 18 })
    expect(moveWindowEdge(window, 'start', 2, 60)).toEqual({ start: 2, end: 7 })
  })

  it('stays inside the audio and rounds to two decimals', () => {
    expect(moveWindowEdge({ start: 1, end: 3 }, 'end', 99, 4.123)).toEqual({
      start: 1,
      end: 4.12
    })
    expect(moveWindowEdge({ start: 1, end: 3 }, 'start', -4, 10)).toEqual({ start: 0, end: 3 })
    expect(slideWindow({ start: 1, end: 3 }, 9.5, 10)).toEqual({ start: 8, end: 10 })
    expect(slideWindow({ start: 1, end: 3 }, -1, 10)).toEqual({ start: 0, end: 2 })
    expect(slideWindow({ start: 1.234, end: 3.234 }, 2.3456, null)).toEqual({
      start: 2.35,
      end: 4.35
    })
  })

  it('clamps any window, or gives up for audio shorter than a window', () => {
    expect(clampWindow({ start: 8, end: 20 }, 10)).toEqual({ start: 5, end: 10 })
    expect(clampWindow({ start: 3, end: 3 }, 10)).toEqual({ start: 3, end: 3.2 })
    expect(clampWindow({ start: 0, end: 5 }, 1)).toEqual({ start: 0, end: 1 })
    expect(clampWindow({ start: 0, end: 1 }, 0.1)).toBeNull()
  })

  it('places a new sample two seconds after the last, within the audio', () => {
    expect(newSampleWindow([], 60)).toEqual({ start: 2, end: 7 })
    expect(newSampleWindow([{ start: 3, end: 8 }], 60)).toEqual({ start: 10, end: 15 })
    expect(newSampleWindow([{ start: 3, end: 8 }], 9)).toEqual({ start: 4, end: 9 })
    expect(newSampleWindow([], null)).toEqual({ start: 2, end: 7 })
  })

  it('numbers new samples above the highest label', () => {
    expect(
      nextSampleNumber([
        { key: 'a', label: 'Beispiel 1', start: 0, end: 1 },
        { key: 'b', label: 'Sample 4', start: 0, end: 1 },
        { key: 'c', label: 'Intro', start: 0, end: 1 }
      ])
    ).toBe(5)
    expect(nextSampleNumber([])).toBe(1)
  })

  it('reads seconds and mm:ss, and writes them back', () => {
    expect(parseTime('12.5')).toBe(12.5)
    expect(parseTime('12,5')).toBe(12.5)
    expect(parseTime('01:02.25')).toBe(62.25)
    expect(parseTime('1:00:00')).toBe(3600)
    expect(parseTime('abc')).toBeNull()
    expect(parseTime('1:-2')).toBeNull()
    expect(parseTime('')).toBeNull()
    expect(formatWindowTime(62.25)).toBe('01:02.25')
    expect(formatWindowTime(3725.5)).toBe('01:02:05.50')
    expect(formatWindowTime(Number.NaN)).toBe('00:00.00')
  })

  it('shows ten times the window around it, at least ten seconds, inside the audio', () => {
    expect(windowView({ start: 100, end: 105 }, 600)).toEqual({ start: 77.5, end: 127.5 })
    expect(windowView({ start: 20, end: 25 }, 600)).toEqual({ start: 0, end: 50 })
    expect(windowView({ start: 1, end: 2 }, 600)).toEqual({ start: 0, end: 10 })
    expect(windowView({ start: 595, end: 600 }, 600)).toEqual({ start: 550, end: 600 })
    expect(windowView({ start: 1, end: 3 }, 4)).toEqual({ start: 0, end: 4 })
  })
})

describe('voiceDispatch (T-18 to T-20)', () => {
  it('sends names, every sample window and colours', () => {
    const voices = [
      voice({
        name: 'Ada',
        colorId: 7,
        samples: [
          { key: 'a', label: 'Sample 1', start: 0.031, end: 5.031 },
          { key: 'b', label: 'Sample 2', start: 9, end: 11 }
        ]
      }),
      voice({ id: 'manual_1', manual: true, name: '', start: null, end: null, samples: [] })
    ]
    expect(voiceDispatch(voices, 60, autoLabel)).toEqual({
      mapping: { SPEAKER_00: 'Ada', manual_1: 'Voice 2' },
      snippets: [
        { id: 'SPEAKER_00', name: 'Ada', start: 0.03, end: 5.03 },
        { id: 'SPEAKER_00', name: 'Ada', start: 9, end: 11 }
      ],
      colors: { SPEAKER_00: 7, manual_1: 2 }
    })
  })

  it('falls back to the analysed range and drops windows outside the audio', () => {
    const voices = [
      voice({ name: 'Stimme 1', start: 0.5, end: 4 }),
      voice({
        id: 'b',
        name: 'Bo',
        samples: [{ key: 'x', label: 'Sample 1', start: 30, end: 32 }]
      })
    ]
    const dispatch = voiceDispatch(voices, 20, autoLabel)
    expect(dispatch.mapping).toEqual({ SPEAKER_00: 'Voice 1', b: 'Bo' })
    expect(dispatch.snippets).toEqual([{ id: 'SPEAKER_00', name: 'Voice 1', start: 0.5, end: 4 }])
  })
})
