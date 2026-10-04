import { describe, expect, it } from 'vitest'
import { TRANSCRIPT_PRESETS, type TranscriptionSegment } from '@justcampus/shared'
import {
  anonymousNames,
  formatClock,
  formatTranscript,
  initialsOf,
  protocolText,
  redactedText,
  segmentsJson,
  speakerColorId,
  speakerLabel,
  transcriptPlainText,
  type ProtocolLabels,
  type SpeakerLabels
} from './format'

const labels: SpeakerLabels = {
  unknown: 'Unbekannt',
  unknownN: (n) => `Unbekannt ${n}`,
  voice: (n) => `Stimme ${n}`,
  anonymous: (n) => `Speaker ${n}`
}

const protocolLabels: ProtocolLabels = {
  header: 'VERLAUFSPROTOKOLL',
  createdAt: 'Erstellt am: 10/4/2026, 1:20:34 AM',
  transcriptId: 'Transkription-ID: af5d2ce4-5f7c-4599-a80e-44dfb7a284ec',
  participants: 'TEILNEHMER:',
  allHidden: '[Alle Sprecher ausgeblendet]'
}

const TEXT =
  'Guten Tag. Dies ist ein kurzer Test der Transkription für die Universität Gießen. Wir treffen uns am Montag um 10 Uhr. Vielen Dank.'

/** The reference run's segment, with the decoder fields the JSON export keeps. */
const FIXTURE: TranscriptionSegment = {
  id: 1,
  start: 0,
  end: 10.72,
  speaker: 'Test speaker',
  text: TEXT,
  redactions: [],
  avgLogprob: -0.056824114945534944,
  compressionRatio: 0.9883720930232558,
  noSpeechProb: null,
  temperature: 0,
  seek: 0,
  tokens: [42833, 11204, 13]
}

function segment(change: Partial<TranscriptionSegment>): TranscriptionSegment {
  return { id: 1, start: 0, end: 2, speaker: 'Anna', text: 'Hallo', redactions: [], ...change }
}

const dialog = TRANSCRIPT_PRESETS.dialog_standard

describe('redactedText', () => {
  it('replaces each range and trims', () => {
    expect(
      redactedText({
        text: ' Mein Name ist Max Mustermann. ',
        redactions: [
          { start: 15, end: 18 },
          { start: 19, end: 29 }
        ]
      })
    ).toBe('Mein Name ist [AUSGEBLENDET] [AUSGEBLENDET].')
  })

  it('applies offsets to the stored text and never cuts twice', () => {
    expect(redactedText({ text: '  abc def', redactions: [{ start: 2, end: 5 }] })).toBe(
      '[AUSGEBLENDET] def'
    )
    expect(
      redactedText({
        text: 'abcdef',
        redactions: [
          { start: 0, end: 4 },
          { start: 2, end: 3 }
        ]
      })
    ).toBe('[AUSGEBLENDET]ef')
  })
})

describe('speaker names', () => {
  it('localises automatic voice labels and keeps typed names', () => {
    const english = { ...labels, voice: (n: number) => `Voice ${n}` }
    expect(speakerLabel('Stimme 3', english)).toBe('Voice 3')
    expect(speakerLabel('Speaker 1', english)).toBe('Voice 1')
    expect(speakerLabel('Stimmführer', english)).toBe('Stimmführer')
    expect(speakerLabel(null, english)).toBe('Unbekannt')
    expect(speakerLabel('Unbekannt 2', { ...english, unknownN: (n) => `Unknown ${n}` })).toBe(
      'Unknown 2'
    )
  })

  it('numbers anonymised speakers in order of first appearance', () => {
    const names = anonymousNames(
      [
        segment({ speaker: 'Bea' }),
        segment({ speaker: null }),
        segment({ speaker: 'Bea' }),
        segment({ speaker: 'Al' })
      ],
      labels
    )
    expect([...names]).toEqual([
      ['Bea', 'Speaker 1'],
      ['Unbekannt', 'Speaker 2'],
      ['Al', 'Speaker 3']
    ])
  })

  it('takes the chosen colour, else the default by first appearance', () => {
    const order = ['Anna', 'Ben']
    expect(speakerColorId('Ben', {}, order)).toBe(2)
    expect(speakerColorId('Ben', { Ben: { colorId: 7, speakerIndex: 1 } }, order)).toBe(7)
  })

  it('makes initials', () => {
    expect(initialsOf('Test speaker')).toBe('TS')
    expect(initialsOf('anna')).toBe('AN')
  })
})

describe('formatTranscript', () => {
  const segments = [
    segment({ id: 1, start: 0, end: 4, speaker: 'Anna', text: 'Hallo.' }),
    segment({ id: 2, start: 4.5, end: 6, speaker: 'Anna', text: 'Wie geht es?' }),
    segment({ id: 3, start: 17, end: 19, speaker: 'Anna', text: 'Nach der Pause.' }),
    segment({ id: 4, start: 19, end: 22, speaker: 'Ben', text: 'Gut.' }),
    segment({ id: 5, start: 22, end: 25, speaker: 'Anna', text: 'Schön.' })
  ]

  it('groups chronologically until another speaker or a pause over ten seconds', () => {
    const formatted = formatTranscript(segments, dialog, {}, {}, labels)
    expect(formatted.blocks.map((block) => [block.name, block.start, block.lines])).toEqual([
      ['Anna', 0, ['Hallo. Wie geht es?']],
      ['Anna', 17, ['Nach der Pause.']],
      ['Ben', 19, ['Gut.']],
      ['Anna', 22, ['Schön.']]
    ])
    expect(formatted.participants).toEqual(['Anna', 'Ben'])
  })

  it('groups by speaker with a timestamp per segment', () => {
    const formatted = formatTranscript(segments, { ...dialog, order: 'speaker' }, {}, {}, labels)
    expect(formatted.blocks.map((block) => [block.name, block.lines])).toEqual([
      [
        'Anna',
        [
          '[00:00:00] Hallo.',
          '[00:00:04] Wie geht es?',
          '[00:00:17] Nach der Pause.',
          '[00:00:22] Schön.'
        ]
      ],
      ['Ben', ['[00:00:19] Gut.']]
    ])
  })

  it('leaves hidden speakers out and says when all are hidden', () => {
    const formatted = formatTranscript(segments, dialog, { Ben: false }, {}, labels)
    expect(formatted.participants).toEqual(['Anna'])
    // Without Ben, Anna's last two segments follow each other and form one block, as in kiChat.
    expect(formatted.blocks.map((block) => block.lines[0])).toEqual([
      'Hallo. Wie geht es?',
      'Nach der Pause. Schön.'
    ])
    const none = formatTranscript(segments, dialog, { Anna: false, Ben: false }, {}, labels)
    expect(none.allHidden).toBe(true)
    expect(protocolText(none, dialog, protocolLabels)).toBe('[Alle Sprecher ausgeblendet]')
    expect(transcriptPlainText(none, dialog, '[Alle Sprecher ausgeblendet]')).toBe(
      '[Alle Sprecher ausgeblendet]'
    )
  })

  it('anonymises the shown speakers consistently, segments untouched', () => {
    const before = JSON.stringify(segments)
    const formatted = formatTranscript(segments, { ...dialog, anonymize: true }, {}, {}, labels)
    expect(formatted.blocks.map((block) => block.name)).toEqual([
      'Speaker 1',
      'Speaker 1',
      'Speaker 2',
      'Speaker 1'
    ])
    expect(JSON.stringify(segments)).toBe(before)
  })

  it('applies redactions', () => {
    const formatted = formatTranscript(
      [segment({ text: 'Ich heiße Max.', redactions: [{ start: 10, end: 13 }] })],
      dialog,
      {},
      {},
      labels
    )
    expect(formatted.blocks[0]!.lines).toEqual(['Ich heiße [AUSGEBLENDET].'])
  })
})

describe('protocol and plain text', () => {
  it('reproduces the reference running record', () => {
    const formatted = formatTranscript([FIXTURE], dialog, {}, {}, labels)
    // `/tmp/transcription-ref/transcript.md`, whose time line is the moment of the export.
    expect(protocolText(formatted, dialog, protocolLabels)).toBe(
      `VERLAUFSPROTOKOLL
Erstellt am: 10/4/2026, 1:20:34 AM
Transkription-ID: af5d2ce4-5f7c-4599-a80e-44dfb7a284ec

TEILNEHMER:
- Test speaker

==================================================

[00:00:00] Test speaker:
${TEXT}
`
    )
  })

  it('writes headers as the flags ask', () => {
    const formatted = formatTranscript(
      [
        segment({ start: 0, text: 'Eins.' }),
        segment({ id: 2, start: 3, speaker: 'Ben', text: 'Zwei.' })
      ],
      dialog,
      {},
      {},
      labels
    )
    const body = (flags: { speakers: boolean; timestamps: boolean }): string =>
      protocolText(formatted, { ...dialog, ...flags }, protocolLabels).split('='.repeat(50))[1]!
    expect(body({ speakers: true, timestamps: false })).toBe('\n\nAnna:\nEins.\n\nBen:\nZwei.\n')
    expect(body({ speakers: false, timestamps: true })).toBe(
      '\n\n[00:00:00]:\nEins.\n\n[00:00:03]:\nZwei.\n'
    )
    expect(body({ speakers: false, timestamps: false })).toBe('\n\nEins.\n\nZwei.\n')
    const bySpeaker = formatTranscript(
      [segment({ text: 'Eins.' })],
      { ...dialog, order: 'speaker', timestamps: false },
      {},
      {},
      labels
    )
    expect(
      protocolText(bySpeaker, { ...dialog, order: 'speaker' }, protocolLabels).endsWith(
        '\n\nAnna:\nEins.\n\n'
      )
    ).toBe(true)
  })

  it('reads like the reference preview text', () => {
    const formatted = formatTranscript([FIXTURE], dialog, {}, {}, labels)
    // `/tmp/transcription-ref/transcript.txt`.
    expect(transcriptPlainText(formatted, dialog, '')).toBe(`Test speaker\n[00:00:00]\n${TEXT}`)
    const reading = TRANSCRIPT_PRESETS.lesefassung
    expect(transcriptPlainText(formatted, reading, '')).toBe(`Test speaker\n${TEXT}`)
  })

  it('formats clock times', () => {
    expect(formatClock(0)).toBe('00:00:00')
    expect(formatClock(3725.9)).toBe('01:02:05')
  })
})

describe('segmentsJson', () => {
  it('is the segments array as two-space JSON, redacted text included', () => {
    const segments = [
      FIXTURE,
      segment({ id: 2, text: 'geheim', redactions: [{ start: 0, end: 6 }] })
    ]
    const json = segmentsJson(segments)
    const { avgLogprob, compressionRatio, noSpeechProb, ...rest } = FIXTURE
    expect(JSON.parse(json)).toEqual([
      {
        ...rest,
        avg_logprob: avgLogprob,
        compression_ratio: compressionRatio,
        no_speech_prob: noSpeechProb
      },
      segments[1]
    ])
    expect(json.split('\n')[1]).toBe('  {')
    expect(json).toContain('"text": "geheim"')
  })
})
