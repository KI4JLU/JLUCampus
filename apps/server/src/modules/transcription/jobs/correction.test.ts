import type { TranscriptionSegment } from '@justcampus/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  applyCorrections,
  CORRECTION_SYSTEM_PROMPT,
  correctionBatches,
  correctionPrompt,
  correctSegments,
  formatTranscript,
  InvalidCorrectionError,
  mergeSpeakerRuns,
  parseCorrections
} from './correction.js'

function segment(
  id: number,
  start: number,
  end: number,
  text: string,
  speaker: string | null
): TranscriptionSegment {
  return { id, start, end, text, speaker, redactions: [], avgLogprob: -0.2 }
}

const segments = [
  segment(1, 0, 4, 'Guten Morgen allerseits. Guten Morgen, Herr Schmidt.', 'Stimme 1'),
  segment(2, 4, 8, 'Wir sprechen über projektfönix.', 'Stimme 2'),
  segment(3, 12, 13, 'Ja.', null)
]

afterEach(() => vi.unstubAllGlobals())

describe('kiChat’s correction prompt', () => {
  it('shows the transcript as Segment [i] (speaker): text', () => {
    expect(formatTranscript(segments)).toBe(
      'Segment [0] (Stimme 1): Guten Morgen allerseits. Guten Morgen, Herr Schmidt.\n' +
        'Segment [1] (Stimme 2): Wir sprechen über projektfönix.\n' +
        'Segment [2] (Unbekannt): Ja.\n'
    )
  })

  it('wraps it in kiChat’s instructions and answer format', () => {
    const prompt = correctionPrompt('Segment [0] (A): x\n')
    expect(
      prompt.startsWith('Du bist ein Experte für Gesprächsprotokolle und Transkriptionen.\n')
    ).toBe(true)
    expect(prompt).toContain('Hier ist das Transkript:\nSegment [0] (A): x\n\n')
    expect(prompt).toContain("'katamau' statt 'Kater Mau'")
    expect(prompt.endsWith('kein Markdown-Fencing (kein ```json).')).toBe(true)
    expect(CORRECTION_SYSTEM_PROMPT).toContain('ausschließlich valides JSON')
  })
})

describe('applying the answer', () => {
  it('reads the array past thinking and fences, and refuses anything else', () => {
    expect(
      parseCorrections(
        '<think>hm</think>```json\n[{"original_index": 0, "text": "a", "speaker": "A"}, {"text": "b"}]\n```'
      )
    ).toEqual([{ originalIndex: 0, text: 'a', speaker: 'A' }])
    expect(() => parseCorrections('{"original_index": 0}')).toThrow(InvalidCorrectionError)
    expect(() => parseCorrections('kein JSON')).toThrow('Die KI hat keine gültige JSON-Antwort')
  })

  it('splits a segment by text length, strips speaker prefixes, keeps what was left out', () => {
    const corrected = applyCorrections(
      segments,
      [
        { originalIndex: 0, text: 'Guten Morgen allerseits.', speaker: 'Stimme 1' },
        { originalIndex: 0, text: 'Stimme 2: Guten Morgen, Herr Schmidt.', speaker: 'Stimme 2' },
        { originalIndex: 1, text: 'Wir sprechen über Projekt Phoenix.', speaker: 'Erfunden' }
      ],
      ['Stimme 1', 'Stimme 2']
    )
    expect(
      corrected.map(({ start, end, text, speaker }) => ({ start, end, text, speaker }))
    ).toEqual([
      // 24 and 37 bytes of 61: the time is shared in proportion.
      { start: 0, end: 1.57, text: 'Guten Morgen allerseits.', speaker: 'Stimme 1' },
      { start: 1.57, end: 4, text: 'Guten Morgen, Herr Schmidt.', speaker: 'Stimme 2' },
      // A name not in the transcript keeps the segment's speaker.
      { start: 4, end: 8, text: 'Wir sprechen über Projekt Phoenix.', speaker: 'Stimme 2' },
      { start: 12, end: 13, text: 'Ja.', speaker: null }
    ])
    expect(corrected[0]).toMatchObject({ avgLogprob: -0.2, redactions: [] })
    expect(corrected[3]).toBe(segments[2])
  })

  it('merges one speaker’s neighbours under 3 s and numbers from 1', () => {
    const merged = mergeSpeakerRuns([
      segment(7, 0, 2, 'Eins.', 'A'),
      segment(8, 2.5, 3, 'Zwei.', 'A'),
      segment(9, 6.5, 7, 'Drei.', 'A'),
      segment(10, 7, 8, 'Vier.', 'B')
    ])
    expect(
      merged.map(({ id, start, end, text, speaker }) => ({ id, start, end, text, speaker }))
    ).toEqual([
      { id: 1, start: 0, end: 3, text: 'Eins. Zwei.', speaker: 'A' },
      { id: 2, start: 6.5, end: 7, text: 'Drei.', speaker: 'A' },
      { id: 3, start: 7, end: 8, text: 'Vier.', speaker: 'B' }
    ])
  })

  it('batches by count and size, in order', () => {
    const many = Array.from({ length: 320 }, (_, index) => ({ text: `Satz ${index}` }))
    expect(correctionBatches(many).map((batch) => batch.length)).toEqual([150, 150, 20])
    const long = [{ text: 'x'.repeat(15_000) }, { text: 'y'.repeat(6000) }]
    expect(correctionBatches(long).map((batch) => batch.length)).toEqual([1, 1])
  })
})

describe('correctSegments', () => {
  it('asks the chat model as kiChat does and applies its answer', async () => {
    const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => {
      const content = JSON.stringify([
        { original_index: 0, text: 'Guten Morgen allerseits.', speaker: 'Stimme 1' },
        { original_index: 0, text: 'Guten Morgen, Herr Schmidt.', speaker: 'Stimme 2' },
        { original_index: 1, text: 'Wir sprechen über Projekt Phoenix.', speaker: 'Stimme 2' },
        { original_index: 2, text: 'Ja.', speaker: 'Stimme 1' }
      ])
      return Response.json({ choices: [{ message: { content } }] })
    })
    vi.stubGlobal('fetch', fetch)
    const progress: Array<[number, number]> = []
    const corrected = await correctSegments(
      segments,
      {
        baseUrl: 'https://llm.test/v1',
        apiKey: null,
        model: 'jlu/qwen3.8-27b-fast',
        timeoutMs: 1000,
        disableThinking: true
      },
      { onBatch: (done, total) => void progress.push([done, total]) }
    )
    expect(corrected.map(({ id, text, speaker }) => ({ id, text, speaker }))).toEqual([
      { id: 1, text: 'Guten Morgen allerseits.', speaker: 'Stimme 1' },
      {
        id: 2,
        text: 'Guten Morgen, Herr Schmidt. Wir sprechen über Projekt Phoenix.',
        speaker: 'Stimme 2'
      },
      { id: 3, text: 'Ja.', speaker: 'Stimme 1' }
    ])
    expect(progress).toEqual([[0, 1]])
    const body = JSON.parse(String(fetch.mock.calls[0]![1].body)) as {
      model: string
      stream: boolean
      messages: Array<{ role: string; content: string }>
    }
    expect(body.model).toBe('jlu/qwen3.8-27b-fast')
    expect(body.stream).toBe(false)
    expect(body.messages[0]).toEqual({ role: 'system', content: CORRECTION_SYSTEM_PROMPT })
    expect(body.messages[1]!.content).toContain(
      'Segment [1] (Stimme 2): Wir sprechen über projektfönix.'
    )
  })
})
