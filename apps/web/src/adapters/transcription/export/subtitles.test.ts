import { describe, expect, it } from 'vitest'
import type { TranscriptionSegment } from '@justcampus/shared'
import type { SpeakerLabels } from './format'
import {
  formatSubtitleTime,
  subtitleCues,
  toSrt,
  toVtt,
  wrapSubtitleLines,
  SUBTITLE_LINE_CHARS
} from './subtitles'

const labels: SpeakerLabels = {
  unknown: 'Unbekannt',
  unknownN: (n) => `Unbekannt ${n}`,
  voice: (n) => `Stimme ${n}`,
  anonymous: (n) => `Speaker ${n}`
}

/** The segment of the reference run (section 3). */
const FIXTURE: TranscriptionSegment = {
  id: 1,
  start: 0,
  end: 10.72,
  speaker: 'Test speaker',
  text: 'Guten Tag. Dies ist ein kurzer Test der Transkription für die Universität Gießen. Wir treffen uns am Montag um 10 Uhr. Vielen Dank.',
  redactions: []
}

/** `/tmp/transcription-ref/srt.srt`, byte for byte. */
const FIXTURE_SRT = `1
00:00:00,000 --> 00:00:05,657
[Test speaker]: Guten Tag. Dies ist ein
kurzer Test der Transkription für die

2
00:00:06,157 --> 00:00:10,720
Universität Gießen. Wir treffen uns am
Montag um 10 Uhr. Vielen Dank.

`

/** `/tmp/transcription-ref/srt.vtt`, byte for byte. */
const FIXTURE_VTT = `WEBVTT

1
00:00:00.000 --> 00:00:05.657
[Test speaker]: Guten Tag. Dies ist ein
kurzer Test der Transkription für die

2
00:00:06.157 --> 00:00:10.720
Universität Gießen. Wir treffen uns am
Montag um 10 Uhr. Vielen Dank.

`

function segment(change: Partial<TranscriptionSegment>): TranscriptionSegment {
  return { id: 1, start: 0, end: 2, speaker: null, text: 'Hallo', redactions: [], ...change }
}

describe('subtitles', () => {
  it('reproduces the reference SRT and VTT', () => {
    const cues = subtitleCues([FIXTURE], labels)
    expect(toSrt(cues)).toBe(FIXTURE_SRT)
    expect(toVtt(cues)).toBe(FIXTURE_VTT)
  })

  it('wraps greedily at 42 characters and leaves long words whole', () => {
    const lines = wrapSubtitleLines('[Test speaker]: ' + FIXTURE.text)
    expect(lines.every((line) => line.length <= SUBTITLE_LINE_CHARS)).toBe(true)
    expect(lines[0]).toBe('[Test speaker]: Guten Tag. Dies ist ein')
    const long = 'x'.repeat(50)
    expect(wrapSubtitleLines(`a ${long} b`)).toEqual(['a', long, 'b'])
  })

  it('formats times with cut milliseconds and hours past a day', () => {
    expect(formatSubtitleTime(5.6577)).toBe('00:00:05,657')
    expect(formatSubtitleTime(3661.5, '.')).toBe('01:01:01.500')
    expect(formatSubtitleTime(90000)).toBe('25:00:00,000')
  })

  it('keeps half a second between cues and a minimum duration', () => {
    const cues = subtitleCues(
      [
        segment({ start: 0, end: 0.2, text: 'Kurz' }),
        segment({ id: 2, start: 0.3, end: 0.4, text: 'Auch kurz' })
      ],
      labels
    )
    expect(cues[0]).toMatchObject({ start: 0, end: 1 })
    expect(cues[1]!.start).toBeCloseTo(1.5)
    expect(cues[1]!.end - cues[1]!.start).toBeCloseTo(1)
  })

  it('lasts at most seven seconds where the text allows', () => {
    const [cue] = subtitleCues([segment({ start: 0, end: 30, text: 'Ein kurzer Satz.' })], labels)
    expect(cue!.end).toBe(7)
  })

  it('names known speakers only, applies redactions and anonymises', () => {
    const segments = [
      segment({ speaker: 'Unbekannt 1', text: 'Ohne Namen' }),
      segment({ id: 2, start: 3, end: 5, speaker: null, text: 'Auch ohne' }),
      segment({
        id: 3,
        start: 6,
        end: 8,
        speaker: 'Anna',
        text: 'Mein Passwort ist geheim',
        redactions: [{ start: 18, end: 24 }]
      })
    ]
    const texts = subtitleCues(segments, labels).map((cue) => cue.text)
    expect(texts).toEqual(['Ohne Namen', 'Auch ohne', '[Anna]: Mein Passwort ist [AUSGEBLENDET]'])
    const anonymous = subtitleCues(segments, labels, true).map((cue) => cue.text)
    // Missing speakers count in the numbering but are never named, as in kiChat.
    expect(anonymous[2]).toBe('[Speaker 3]: Mein Passwort ist\n[AUSGEBLENDET]')
  })

  it('shows automatic voice labels in the current language', () => {
    const english = { ...labels, voice: (n: number) => `Voice ${n}` }
    const [cue] = subtitleCues([segment({ speaker: 'Stimme 2', text: 'Hallo' })], english)
    expect(cue!.text).toBe('[Voice 2]: Hallo')
  })

  it('skips segments without text', () => {
    expect(subtitleCues([segment({ text: '   ' })], labels)).toEqual([])
    expect(toSrt([])).toBe('')
    expect(toVtt([])).toBe('WEBVTT\n\n')
  })
})
