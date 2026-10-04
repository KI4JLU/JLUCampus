import { describe, expect, it } from 'vitest'
import {
  TRANSCRIPT_PRESET_IDS,
  TRANSCRIPT_PRESETS,
  TRANSCRIPTION_FORMAT_NAME_MAX,
  transcriptionFormatInputSchema
} from '@justcampus/shared'
import { exportFilename, formatsOf, FORMAT_EXTENSIONS, FORMAT_TYPES } from './files'
import { formatDetails, presetFlags, uniqueFormatName } from './presets'
import { exportActions, exportStore } from './store'

describe('presets', () => {
  it('sets every flag of a preset, and a change makes the format custom', () => {
    for (const id of TRANSCRIPT_PRESET_IDS) {
      exportActions.choosePreset(id)
      expect(exportStore.get().flags).toEqual(presetFlags(id))
      expect(exportStore.get().choice).toEqual({ kind: 'preset', id })
    }
    exportActions.choosePreset('lesefassung')
    exportActions.setFlag('timestamps', true)
    expect(exportStore.get().choice).toEqual({ kind: 'custom' })
    exportActions.choosePreset('lesefassung')
    expect(exportStore.get().flags).toEqual(TRANSCRIPT_PRESETS.lesefassung)
  })

  it('keeps the truth table', () => {
    const table = TRANSCRIPT_PRESET_IDS.map((id) => {
      const flags = TRANSCRIPT_PRESETS[id]
      return [
        id,
        +flags.speakers,
        +flags.timestamps,
        +flags.avatars,
        +flags.bubbles,
        +flags.anonymize,
        flags.order
      ]
    })
    expect(table).toEqual([
      ['dialog_standard', 1, 1, 1, 1, 0, 'chronological'],
      ['lesefassung', 1, 0, 0, 0, 0, 'chronological'],
      ['zeitcodes', 0, 1, 0, 0, 0, 'chronological'],
      ['sprecher_gruppiert', 1, 0, 0, 0, 0, 'speaker'],
      ['fliesstext', 0, 0, 0, 0, 0, 'chronological']
    ])
  })

  it('uses a saved format, changes it on save and falls back when it is deleted', () => {
    const format = {
      id: '7a7c1d68-7c55-4a39-9b55-6b1a2b8d6d01',
      name: 'Mein Format',
      speakers: false,
      timestamps: true,
      avatars: false,
      bubbles: true,
      anonymize: true,
      order: 'speaker' as const,
      createdAt: '2026-10-04T00:00:00.000Z',
      updatedAt: '2026-10-04T00:00:00.000Z'
    }
    exportActions.chooseFormat(format)
    expect(exportStore.get()).toMatchObject({
      choice: { kind: 'saved', id: format.id },
      editingFormatId: format.id,
      flags: { speakers: false, timestamps: true, anonymize: true, order: 'speaker' }
    })
    exportActions.setFlag('avatars', true)
    expect(exportStore.get().editingFormatId).toBe(format.id)
    exportActions.choosePreset('zeitcodes')
    expect(exportStore.get().editingFormatId).toBeNull()
    exportActions.chooseFormat(format)
    exportActions.formatDeleted(format.id)
    expect(exportStore.get().choice).toEqual({ kind: 'preset', id: 'dialog_standard' })
  })

  it('keeps visible speakers per transcript', () => {
    exportActions.toggleSpeaker('t1', 'Anna')
    expect(exportStore.get().visibleSpeakers).toEqual({ t1: { Anna: false } })
    exportActions.toggleSpeaker('t1', 'Anna')
    expect(exportStore.get().visibleSpeakers.t1).toEqual({ Anna: true })
  })
})

describe('format names', () => {
  const formats = [
    { id: 'a', name: 'Interview' },
    { id: 'b', name: 'interview (1)' }
  ]

  it('refuses blank names and numbers taken ones, ignoring case', () => {
    expect(uniqueFormatName('   ', formats, null)).toBeNull()
    expect(uniqueFormatName(' Neu ', formats, null)).toBe('Neu')
    expect(uniqueFormatName('INTERVIEW', formats, null)).toBe('INTERVIEW (2)')
  })

  it('keeps a numbered name of the longest allowed one within the limit', () => {
    const longest = 'x'.repeat(TRANSCRIPTION_FORMAT_NAME_MAX)
    const taken = [
      { id: 'a', name: longest },
      { id: 'b', name: `${'x'.repeat(TRANSCRIPTION_FORMAT_NAME_MAX - 4)} (1)` }
    ]
    const name = uniqueFormatName(longest, taken, null)!
    expect(name).toBe(`${'x'.repeat(TRANSCRIPTION_FORMAT_NAME_MAX - 4)} (2)`)
    expect(name).toHaveLength(TRANSCRIPTION_FORMAT_NAME_MAX)
    // What the browser sends is what the server accepts.
    expect(
      transcriptionFormatInputSchema.safeParse({
        id: null,
        name,
        ...TRANSCRIPT_PRESETS.dialog_standard
      }).success
    ).toBe(true)
    // A space where the base is cut does not stay before the suffix.
    const spaced = `${'y'.repeat(TRANSCRIPTION_FORMAT_NAME_MAX - 5)} zzzz`
    expect(uniqueFormatName(spaced, [{ id: 'a', name: spaced }], null)).toBe(
      `${'y'.repeat(TRANSCRIPTION_FORMAT_NAME_MAX - 5)} (1)`
    )
  })

  it('lets the format being changed keep its name', () => {
    expect(uniqueFormatName('Interview', formats, 'a')).toBe('Interview')
  })

  it('describes a format', () => {
    const labels = {
      names: 'Namen',
      timestamps: 'Zeitstempel',
      avatars: 'Avatare',
      bubbles: 'Blasen',
      anonymised: 'Anonymisiert',
      chronological: 'chronologisch',
      bySpeaker: 'nach Sprecher'
    }
    expect(formatDetails(TRANSCRIPT_PRESETS.dialog_standard, labels)).toBe(
      'Namen · Zeitstempel · Avatare · Blasen · chronologisch'
    )
    expect(
      formatDetails({ ...TRANSCRIPT_PRESETS.fliesstext, anonymize: true, order: 'speaker' }, labels)
    ).toBe('Anonymisiert · nach Sprecher')
  })
})

describe('files', () => {
  it('names downloads after the transcript', () => {
    expect(exportFilename('af5d2ce4', 'markdown')).toBe('transkription-af5d2ce4.md')
    expect(exportFilename('af5d2ce4', 'docx')).toBe('transkription-af5d2ce4.docx')
    expect(exportFilename(null, 'json')).toBe('transkription-export.json')
  })

  it('offers kiChat formats per category', () => {
    expect(formatsOf('summary')).toEqual(['docx', 'pdf', 'markdown', 'txt'])
    expect(formatsOf('transcript')).toEqual(['docx', 'pdf', 'markdown', 'txt'])
    expect(formatsOf('subtitles')).toEqual(['srt', 'vtt'])
    expect(formatsOf('json')).toEqual(['json'])
    expect(FORMAT_EXTENSIONS.vtt).toBe('vtt')
    expect(FORMAT_TYPES.txt).toBe('text/plain;charset=utf-8')
    expect(FORMAT_TYPES.json).toBe('application/json;charset=utf-8')
  })
})
