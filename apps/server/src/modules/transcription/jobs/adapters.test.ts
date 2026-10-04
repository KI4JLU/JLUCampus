import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { UpstreamError } from '../http.js'
import { normalizeLanguage, parseVerboseJson, transcribeFile } from './asr.js'
import {
  correctedTexts,
  correctionBatches,
  correctSegments,
  parseLenientJson
} from './correction.js'
import { diarizeFile, parseDiarization } from './diarization.js'
import { isTransient, withRetries } from './pipeline.js'

let directory: string
let wav: string

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'transcription-adapters-'))
  wav = join(directory, 'audio.wav')
  await writeFile(wav, Buffer.from('RIFF....WAVE'))
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await rm(directory, { recursive: true, force: true })
})

/** kiChat's fixture answer (section 3), as Speaches gives it. */
const fixture = {
  task: 'transcribe',
  language: 'german',
  duration: 11.24,
  text: ' Guten Tag. Dies ist ein kurzer Test.',
  segments: [
    {
      id: 1,
      seek: 0,
      start: 0,
      end: 10.72,
      text: ' Guten Tag. Dies ist ein kurzer Test.',
      tokens: [50364, 1, 2],
      temperature: 0,
      avg_logprob: -0.0568241,
      compression_ratio: 0.98837,
      no_speech_prob: null
    },
    { id: 2, seek: 0, start: 10.72, end: 11, text: '   ' }
  ]
}

describe('speech recognition adapter', () => {
  it('maps verbose_json to segments with camelCased decoder fields', () => {
    expect(parseVerboseJson(fixture, 11.24)).toEqual({
      text: 'Guten Tag. Dies ist ein kurzer Test.',
      language: 'de',
      duration: 11.24,
      segments: [
        {
          start: 0,
          end: 10.72,
          text: 'Guten Tag. Dies ist ein kurzer Test.',
          seek: 0,
          tokens: [50364, 1, 2],
          temperature: 0,
          avgLogprob: -0.0568241,
          compressionRatio: 0.98837,
          noSpeechProb: null
        }
      ],
      words: []
    })
  })

  it('turns a segment-less answer into one segment over the chunk', () => {
    expect(parseVerboseJson({ text: 'Nur Text.' }, 3).segments).toEqual([
      expect.objectContaining({ start: 0, end: 3, text: 'Nur Text.' })
    ])
  })

  it('names languages by their code', () => {
    expect(normalizeLanguage('german')).toBe('de')
    expect(normalizeLanguage('EN-us')).toBe('en')
    expect(normalizeLanguage('de')).toBe('de')
    expect(normalizeLanguage('')).toBeNull()
  })

  it('sends the file, model and verbose_json, and no language for auto', async () => {
    const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () =>
      Response.json(fixture)
    )
    vi.stubGlobal('fetch', fetch)
    await transcribeFile(wav, 11.24, {
      baseUrl: 'https://asr.test/v1/',
      apiKey: 'speech-key',
      model: 'jlu/whisper-1',
      language: 'auto',
      timeoutMs: 1000
    })
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('https://asr.test/v1/audio/transcriptions')
    expect(init.redirect).toBe('error')
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer speech-key')
    const form = init.body as FormData
    expect(form.get('model')).toBe('jlu/whisper-1')
    expect(form.get('response_format')).toBe('verbose_json')
    expect(form.has('language')).toBe(false)
    expect(form.get('file')).toBeInstanceOf(Blob)

    await transcribeFile(wav, 1, {
      baseUrl: 'https://asr.test/v1',
      apiKey: null,
      model: 'm',
      language: 'de',
      prompt: 'Vorher.',
      timeoutMs: 1000
    })
    const second = fetch.mock.calls[1]![1].body as FormData
    expect(second.get('language')).toBe('de')
    expect(second.get('prompt')).toBe('Vorher.')
  })

  it('reports an error status with the status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 415 }))
    )
    await expect(
      transcribeFile(wav, 1, {
        baseUrl: 'https://asr.test/v1',
        apiKey: null,
        model: 'm',
        language: 'auto',
        timeoutMs: 1000
      })
    ).rejects.toMatchObject({ status: 415 })
  })
})

describe('diarisation adapter', () => {
  it('reads the common answer shapes', () => {
    const expected = [
      { start: 0, end: 2, speaker: 'A' },
      { start: 2, end: 3, speaker: '1' }
    ]
    expect(
      parseDiarization({
        segments: [
          { start: 0, end: 2, speaker: 'A' },
          { start: 2, end: 3, speaker: 1 }
        ]
      })
    ).toEqual(expected)
    expect(
      parseDiarization([
        { start_time: 0, end_time: 2, label: 'A' },
        { start_time: 2, end_time: 3, speaker_id: 1 },
        { start: 4, end: 3, speaker: 'backwards' },
        { start: 5, speaker: 'no end' }
      ])
    ).toEqual(expected)
    expect(() => parseDiarization({ nothing: true })).toThrow()
  })

  it('sends the speaker count as a hint', async () => {
    const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () =>
      Response.json({ segments: [] })
    )
    vi.stubGlobal('fetch', fetch)
    const request = {
      url: 'https://diar.test/diarize',
      apiKey: 'k',
      model: 'pyannote',
      timeoutMs: 1000
    }
    await diarizeFile(wav, { ...request, speakerCount: 'single' })
    await diarizeFile(wav, { ...request, speakerCount: 'multi' })
    await diarizeFile(wav, { ...request, speakerCount: 'auto' })
    const forms = fetch.mock.calls.map(([, init]) => init.body as FormData)
    expect(forms[0]!.get('num_speakers')).toBe('1')
    expect(forms[1]!.get('min_speakers')).toBe('2')
    expect(forms[2]!.has('num_speakers') || forms[2]!.has('min_speakers')).toBe(false)
    expect(forms[0]!.get('model')).toBe('pyannote')
  })

  it('reports kiChat’s 415 with its status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 415 }))
    )
    await expect(
      diarizeFile(wav, {
        url: 'https://diar.test',
        apiKey: null,
        model: null,
        speakerCount: 'auto',
        timeoutMs: 1000
      })
    ).rejects.toMatchObject({ status: 415 })
  })
})

describe('LLM correction', () => {
  const segments = [
    {
      id: 1,
      start: 0,
      end: 4,
      text: 'wir treffen uns um zehn Uhr',
      speaker: 'Anna',
      redactions: []
    },
    { id: 2, start: 4, end: 8, text: 'danke', speaker: 'Ben', redactions: [], seek: 7 }
  ]

  it('parses JSON in fences or prose', () => {
    expect(parseLenientJson('```json\n{"text":["a"]}\n```')).toEqual({ text: ['a'] })
    expect(parseLenientJson('Hier: {"text":["a"]} fertig')).toEqual({ text: ['a'] })
    expect(parseLenientJson('kein JSON')).toBeUndefined()
  })

  it('takes one text per segment or none', () => {
    expect(correctedTexts({ text: ['A', 'B'] }, ['a', 'b'])).toEqual(['A', 'B'])
    expect(correctedTexts(['A'], ['a', 'b'])).toBeNull()
    expect(correctedTexts({ text: ['', 7] }, ['a', 'b'])).toEqual(['a', 'b'])
    // A text far off the original's length is no correction.
    expect(
      correctedTexts({ text: ['kurz'] }, ['ein ziemlich langer Satz mit vielen Wörtern'])
    ).toEqual(['ein ziemlich langer Satz mit vielen Wörtern'])
    expect(correctedTexts({ text: ['zwei\nZeilen'] }, ['zwei Zeilen'])).toEqual(['zwei Zeilen'])
  })

  it('batches by count and size, in order', () => {
    const many = Array.from({ length: 95 }, (_, index) => ({ text: `Satz ${index}` }))
    expect(correctionBatches(many).map((batch) => batch.length)).toEqual([40, 40, 15])
    const long = [{ text: 'x'.repeat(7000) }, { text: 'y'.repeat(2000) }]
    expect(correctionBatches(long).map((batch) => batch.length)).toEqual([1, 1])
  })

  it('changes only the text and keeps boundaries, timing and fields', async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: Array<{ content: string }> }
      const texts = JSON.parse(body.messages[1]!.content) as string[]
      const content = JSON.stringify({ text: texts.map((text) => text.replace('zehn', '10')) })
      return Response.json({ choices: [{ message: { content } }] })
    })
    vi.stubGlobal('fetch', fetch)
    const progress: Array<[number, number]> = []
    const corrected = await correctSegments(
      segments,
      {
        baseUrl: 'https://llm.test/v1',
        apiKey: null,
        model: 'mock-chat',
        language: 'de',
        timeoutMs: 1000
      },
      { onBatch: (done, total) => void progress.push([done, total]) }
    )
    expect(corrected).toEqual([{ ...segments[0], text: 'wir treffen uns um 10 Uhr' }, segments[1]])
    expect(progress).toEqual([[0, 1]])
    const body = JSON.parse(String(fetch.mock.calls[0]![1].body)) as {
      messages: Array<{ role: string; content: string }>
    }
    expect(body.messages[0]!.content).toContain('speech recognition')
    expect(body.messages[0]!.content).toContain('German')
  })
})

describe('upstream retries', () => {
  it('retries passing failures a bounded number of times', async () => {
    const signal = new AbortController().signal
    const call = vi.fn(async () => {
      throw new UpstreamError('down', 503)
    })
    await expect(withRetries(call, signal, [0, 0])).rejects.toMatchObject({ status: 503 })
    expect(call).toHaveBeenCalledTimes(3)
  })

  it('does not retry an answer that will not change', async () => {
    const call = vi.fn(async () => {
      throw new UpstreamError('bad', 415)
    })
    await expect(withRetries(call, new AbortController().signal, [0])).rejects.toThrow('bad')
    expect(call).toHaveBeenCalledTimes(1)
    expect(isTransient(new UpstreamError('timeout'))).toBe(true)
    expect(isTransient(new UpstreamError('limit', 429))).toBe(true)
    expect(isTransient(new Error('other'))).toBe(false)
  })

  it('succeeds after a passing failure', async () => {
    let calls = 0
    const value = await withRetries(
      async () => {
        if (calls++ === 0) throw new UpstreamError('blip')
        return 'ok'
      },
      new AbortController().signal,
      [0]
    )
    expect(value).toBe('ok')
  })
})
