import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { UpstreamError } from '../http.js'
import {
  normalizeLanguage,
  parseVerboseJson,
  transcribeChunksParallel,
  transcribeFile
} from './asr.js'
import {
  diarizationForm,
  diarizationTimeoutMs,
  diarizeFile,
  parseDiarization,
  parseSpeechTimestamps,
  speechTimestamps,
  vadTimeoutMs
} from './diarization.js'
import { ConcurrencyLimiter } from './limiter.js'
import { isRetryable, postToServer, withRetry } from './upstream.js'

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

  it('reads the HRZ gateway’s answer: words null, the duration as a string', () => {
    const parsed = parseVerboseJson(
      { ...fixture, language: 'de', duration: '11.24', words: null, usage: null },
      null
    )
    expect(parsed.duration).toBe(11.24)
    expect(parsed.words).toEqual([])
    expect(parsed.segments).toHaveLength(1)
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

  it('sends kiChat’s fields: model, verbose_json, word timing, no language for auto', async () => {
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
    expect([...form.keys()]).toEqual([
      'model',
      'response_format',
      'timestamp_granularities[]',
      'file'
    ])
    expect(form.get('model')).toBe('jlu/whisper-1')
    expect(form.get('response_format')).toBe('verbose_json')
    expect(form.getAll('timestamp_granularities[]')).toEqual(['word'])
    expect(form.get('file')).toBeInstanceOf(Blob)

    await transcribeFile(wav, 1, {
      baseUrl: 'https://asr.test/v1',
      apiKey: null,
      model: 'm',
      language: 'de',
      timeoutMs: 1000
    })
    const second = fetch.mock.calls[1]![1].body as FormData
    expect(second.get('language')).toBe('de')
    expect(second.has('prompt')).toBe(false)
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

describe('parallel recognition (kiChat’s transcribeAudioParallel)', () => {
  const request = {
    apiKey: 'k',
    model: 'jlu/whisper-1',
    language: 'auto' as const,
    timeoutMs: 1000,
    retryDelayMs: 0
  }

  it('sends waves within the budget, round-robin over the workers, results in order', async () => {
    let inFlight = 0
    let most = 0
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url)
        inFlight++
        most = Math.max(most, inFlight)
        await new Promise((done) => setTimeout(done, 5))
        inFlight--
        return Response.json({ ...fixture, text: url })
      })
    )
    const waves: number[] = []
    const results = await transcribeChunksParallel(
      Array.from({ length: 5 }, () => ({ path: wav, duration: 1 })),
      {
        ...request,
        baseUrls: ['https://a.test/v1', ' https://b.test/v1 '],
        limit: 2,
        limiter: new ConcurrencyLimiter(2),
        onWave: (done) => void waves.push(done)
      }
    )
    expect(most).toBe(2)
    expect(waves).toEqual([2, 4, 5])
    expect(urls).toEqual([
      'https://a.test/v1/audio/transcriptions',
      'https://b.test/v1/audio/transcriptions',
      'https://a.test/v1/audio/transcriptions',
      'https://b.test/v1/audio/transcriptions',
      'https://a.test/v1/audio/transcriptions'
    ])
    expect(results.map((result) => result.text)).toEqual(urls)
  })

  it('shares the budget with other jobs: a busy limiter shrinks the wave', async () => {
    const limiter = new ConcurrencyLimiter(3)
    const other = await limiter.acquire(2)
    let most = 0
    let inFlight = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        most = Math.max(most, ++inFlight)
        await new Promise((done) => setTimeout(done, 5))
        inFlight--
        return Response.json(fixture)
      })
    )
    await transcribeChunksParallel(
      Array.from({ length: 3 }, () => ({ path: wav, duration: 1 })),
      { ...request, baseUrls: ['https://a.test/v1'], limit: 3, limiter }
    )
    expect(most).toBe(1)
    expect(limiter.inUse).toBe(2)
    other.release()
    expect(limiter.inUse).toBe(0)
  })

  it('retries transport errors and 5xx retry_times times in all, not 4xx', async () => {
    const fetch = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(Response.json(fixture))
    vi.stubGlobal('fetch', fetch)
    await transcribeChunksParallel([{ path: wav, duration: 1 }], {
      ...request,
      baseUrls: ['https://a.test/v1'],
      limit: 1,
      limiter: new ConcurrencyLimiter(1)
    })
    expect(fetch).toHaveBeenCalledTimes(3)

    const refused = vi.fn(async () => new Response('bad', { status: 400 }))
    vi.stubGlobal('fetch', refused)
    await expect(
      transcribeChunksParallel([{ path: wav, duration: 1 }], {
        ...request,
        baseUrls: ['https://a.test/v1'],
        limit: 1,
        limiter: new ConcurrencyLimiter(1)
      })
    ).rejects.toMatchObject({ status: 400 })
    expect(refused).toHaveBeenCalledTimes(1)
  })
})

describe('upstream retries (kiChat’s rules)', () => {
  it('retries transport errors and 5xx, never 4xx or a processing timeout', () => {
    expect(isRetryable(new UpstreamError('down', 503))).toBe(true)
    expect(isRetryable(new UpstreamError('unreachable'))).toBe(true)
    expect(isRetryable(new UpstreamError('limit', 429))).toBe(false)
    expect(isRetryable(new UpstreamError('bad', 415))).toBe(false)
    expect(isRetryable(new UpstreamError('slow', null, null, true))).toBe(false)
    expect(isRetryable(new Error('other'))).toBe(false)
  })

  it('withRetry tries retry_times in all with the fixed delay', async () => {
    const call = vi.fn(async () => {
      throw new UpstreamError('down', 503)
    })
    await expect(withRetry(call, { times: 3, delayMs: 0 })).rejects.toMatchObject({ status: 503 })
    expect(call).toHaveBeenCalledTimes(3)
    let calls = 0
    const value = await withRetry(
      async () => {
        if (calls++ === 0) throw new UpstreamError('blip')
        return 'ok'
      },
      { delayMs: 0 }
    )
    expect(value).toBe('ok')
  })

  it('postToServer returns 2xx and 4xx at once, retries 5xx with 2 × attempt seconds', async () => {
    const pauses: number[] = []
    const fetch = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response('', { status: 502 }))
      .mockResolvedValueOnce(new Response('', { status: 500 }))
      .mockResolvedValueOnce(new Response('{"segments":[]}', { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const limiter = new ConcurrencyLimiter(1)
    const answer = await postToServer('https://d.test/v1/audio/diarization', new FormData(), {
      apiKey: 'k',
      timeoutMs: 1000,
      label: 'diarization',
      limiter,
      backoffMs: (attempt) => {
        pauses.push(2000 * attempt)
        return 0
      }
    })
    expect(answer).toEqual({ body: '{"segments":[]}', status: 200, error: '', timedOut: false })
    expect(pauses).toEqual([2000, 4000])
    expect(limiter.inUse).toBe(0)

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Invalid API key', { status: 403 }))
    )
    const refused = await postToServer('https://d.test', new FormData(), {
      apiKey: null,
      timeoutMs: 1000,
      label: 'diarization',
      limiter
    })
    expect(refused).toMatchObject({ status: 403, body: 'Invalid API key', error: '' })
  })

  it('does not retry a request that timed out while the server was processing it', async () => {
    const fetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(init.signal!.reason))
        })
    )
    vi.stubGlobal('fetch', fetch)
    const answer = await postToServer('https://d.test', new FormData(), {
      apiKey: null,
      timeoutMs: 20,
      label: 'diarization',
      limiter: new ConcurrencyLimiter(1),
      backoffMs: () => 0
    })
    expect(answer).toMatchObject({ status: 0, timedOut: true, error: 'Zeitüberschreitung nach 0s' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('diarisation adapter (Speaches contract)', () => {
  it('scales the timeout with the duration: clamp(2 × d + 120 s, 600 s, 3600 s)', () => {
    expect(diarizationTimeoutMs(null)).toBe(600_000)
    expect(diarizationTimeoutMs(0)).toBe(600_000)
    expect(diarizationTimeoutMs(60)).toBe(600_000)
    expect(diarizationTimeoutMs(300)).toBe(720_000)
    expect(diarizationTimeoutMs(1000.2)).toBe(2_121_000)
    expect(diarizationTimeoutMs(6300)).toBe(3_600_000)
    // VAD shares the budget up to 900 s.
    expect(vadTimeoutMs(300)).toBe(720_000)
    expect(vadTimeoutMs(6300)).toBe(900_000)
  })

  it('builds the multipart fields with speaker hint and known voices', () => {
    const file = new Blob(['RIFF'])
    const known = [
      { name: 'Anna', reference: 'data:audio/wav;base64,AAA=' },
      { name: 'Ben', reference: 'data:audio/wav;base64,BBB=' }
    ]
    const form = diarizationForm(file, {
      model: 'pyannote/speaker-diarization-community-1',
      speakerCount: 'multi',
      knownSpeakers: known
    })
    expect([...form.keys()]).toEqual([
      'model',
      'min_speakers',
      'file',
      'known_speaker_names[0]',
      'known_speaker_names[1]',
      'known_speaker_references[0]',
      'known_speaker_references[1]'
    ])
    expect(form.get('model')).toBe('pyannote/speaker-diarization-community-1')
    expect(form.get('min_speakers')).toBe('2')
    expect(form.get('known_speaker_names[1]')).toBe('Ben')
    expect(form.get('known_speaker_references[0]')).toBe('data:audio/wav;base64,AAA=')
    const single = diarizationForm(file, { model: 'm', speakerCount: 'single' })
    expect(single.get('num_speakers')).toBe('1')
    expect(single.has('min_speakers')).toBe(false)
    const auto = diarizationForm(file, { model: 'm', speakerCount: 'auto' })
    expect([...auto.keys()]).toEqual(['model', 'file'])
  })

  it('reads segments as kiChat does', () => {
    expect(
      parseDiarization({
        segments: [
          { start: 0, end: 2, speaker: 'SPEAKER_00' },
          { start: 2, end: 3, speaker: 1 },
          { start: 4, end: 3, speaker: 'backwards' },
          { start: 5, speaker: 'no end' }
        ]
      })
    ).toEqual([
      { start: 0, end: 2, speaker: 'SPEAKER_00' },
      { start: 2, end: 3, speaker: '1' }
    ])
    expect(parseDiarization({})).toEqual([])
    expect(() => parseDiarization([])).toThrow()
    expect(() => parseDiarization({ segments: 'x' })).toThrow()
  })

  it('posts to {base}/audio/diarization with the diarisation key and reports the status', async () => {
    const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () =>
      Response.json({ segments: [{ start: 0, end: 1, speaker: 'Anna' }] })
    )
    vi.stubGlobal('fetch', fetch)
    const target = {
      baseUrl: 'https://diar.test/diarization/v1/',
      apiKey: 'diar-key',
      limiter: new ConcurrencyLimiter(1),
      backoffMs: () => 0
    }
    const turns = await diarizeFile(wav, 10, { model: 'p', speakerCount: 'auto' }, target)
    expect(turns).toEqual([{ start: 0, end: 1, speaker: 'Anna' }])
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('https://diar.test/diarization/v1/audio/diarization')
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer diar-key')

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 415 }))
    )
    await expect(
      diarizeFile(wav, 10, { model: 'p', speakerCount: 'auto' }, target)
    ).rejects.toMatchObject({ status: 415 })
  })

  it('reads VAD regions from milliseconds and degrades to none', async () => {
    expect(parseSpeechTimestamps([{ start: 30, end: 7900 }, { start: 'x' }, 5])).toEqual([
      { start: 0.03, end: 7.9 }
    ])
    expect(parseSpeechTimestamps({ segments: [] })).toEqual([])
    const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () =>
      Response.json([{ start: 1000, end: 2500 }])
    )
    vi.stubGlobal('fetch', fetch)
    const target = {
      baseUrl: 'https://diar.test/v1',
      apiKey: null,
      limiter: new ConcurrencyLimiter(1)
    }
    expect(await speechTimestamps(wav, 5, target)).toEqual([{ start: 1, end: 2.5 }])
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('https://diar.test/v1/audio/speech/timestamps')
    expect((init.body as FormData).get('model')).toBe('silero_vad_v5')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 404 }))
    )
    expect(await speechTimestamps(wav, 5, target)).toEqual([])
  })
})
