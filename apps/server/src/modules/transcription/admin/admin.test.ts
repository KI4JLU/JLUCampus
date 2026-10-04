import { Readable } from 'node:stream'

import { TRANSCRIPTION_API } from '@justcampus/shared'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { json, startUpstreamMock, testApp, type RunningMock } from '../transcripts/testing.js'

import {
  chatModels,
  safeMessage,
  silentWav,
  testConnection,
  type ConnectionContext,
  type TestStorage
} from './connections.js'
import { adminRouter } from './index.js'

const ADMIN = '/api/admin/modules/transcription'
const models = TRANSCRIPTION_API.adminModels.slice(ADMIN.length)
const test = TRANSCRIPTION_API.adminTest.slice(ADMIN.length)

let mock: RunningMock
beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  mock = await startUpstreamMock()
})
afterAll(async () => {
  await mock.close()
  vi.restoreAllMocks()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('helpers', () => {
  it('keeps chat models only for the chat endpoint', () => {
    expect(
      chatModels([
        { id: 'mock-chat', label: 'Chat' },
        { id: 'text-embedding-3', label: 'E' },
        { id: 'whisper-1', label: 'W' },
        { id: 'gpt-4o-transcribe', label: 'T' }
      ]).map((model) => model.id)
    ).toEqual(['mock-chat'])
  })

  it('masks keys and bearer tokens in messages', () => {
    expect(safeMessage('Incorrect API key sk-live-123 (Bearer abc.def)', ['sk-live-123'])).toBe(
      'Incorrect API key *** (Bearer ***)'
    )
  })

  it('makes a valid silent WAV', () => {
    const wav = silentWav(0.5)
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe('RIFF')
    expect(wav.byteLength).toBe(44 + 16_000)
  })
})

describe('model discovery', () => {
  it('lists speech models unfiltered and chat models without speech or embeddings', async () => {
    const app = testApp(adminRouter)
    const speech = await app.request(
      models,
      json('POST', { kind: 'asr', baseUrl: `${mock.origin}/asr/v1` })
    )
    const { models: speechModels } = (await speech.json()) as { models: Array<{ id: string }> }
    expect(speechModels.map((model) => model.id)).toContain('jlu/whisper-1')
    const chat = await app.request(
      models,
      json('POST', { kind: 'llm', baseUrl: `${mock.origin}/llm/v1` })
    )
    expect(await chat.json()).toEqual({
      models: [
        { id: 'mock-chat', label: 'Mock Chat' },
        { id: 'mock-chat-large', label: 'mock-chat-large' }
      ]
    })
  })

  it('uses the typed key, else the saved one of that endpoint', async () => {
    const fetchMock = vi.fn(async () => Response.json({ data: [{ id: 'm' }] }))
    vi.stubGlobal('fetch', fetchMock)
    const app = testApp(adminRouter, {
      secrets: { apiKey: 'saved-speech', llmApiKey: 'saved-chat' }
    })
    const authorization = (call: number): string | null =>
      new Headers((fetchMock.mock.calls[call] as unknown as [string, RequestInit])[1].headers).get(
        'authorization'
      )
    await app.request(models, json('POST', { kind: 'asr', baseUrl: 'https://asr.example/v1' }))
    await app.request(models, json('POST', { kind: 'llm', baseUrl: 'https://llm.example/v1' }))
    await app.request(
      models,
      json('POST', { kind: 'llm', baseUrl: 'https://llm.example/v1', apiKey: 'typed' })
    )
    await app.request(
      models,
      json('POST', { kind: 'llm', baseUrl: 'https://llm.example/v1', apiKey: null })
    )
    expect([0, 1, 2, 3].map(authorization)).toEqual([
      'Bearer saved-speech',
      'Bearer saved-chat',
      'Bearer typed',
      null
    ])
  })

  it('answers 502 when the endpoint fails, and 400 for plain http elsewhere', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 401 }))
    )
    const app = testApp(adminRouter)
    const failed = await app.request(
      models,
      json('POST', { kind: 'asr', baseUrl: 'https://asr.example/v1' })
    )
    expect(failed.status).toBe(502)
    const insecure = await app.request(
      models,
      json('POST', { kind: 'asr', baseUrl: 'http://asr.example/v1' })
    )
    expect(insecure.status).toBe(400)
  })
})

describe('connection tests', () => {
  const runtime = (
    overrides: Record<string, unknown> = {}
  ): { config: Record<string, unknown>; secrets: Record<string, string | null> } => ({
    config: {
      ...testConfig(),
      ...overrides
    },
    secrets: {
      apiKey: 'sk-speech-secret',
      diarizationApiKey: null,
      llmApiKey: null,
      openaiRealtimeApiKey: 'sk-openai-secret'
    }
  })
  function testConfig(): Record<string, unknown> {
    return {
      asrBaseUrl: `${mock.origin}/asr/v1`,
      asrModels: [{ id: 'jlu/whisper-1', label: 'Whisper' }],
      defaultAsrModel: 'jlu/whisper-1',
      llmBaseUrl: `${mock.origin}/llm/v1`,
      llmModels: [{ id: 'mock-chat', label: 'Mock Chat' }],
      defaultSummaryModel: 'mock-chat',
      onpremSignalingUrl: `${mock.origin}/realtime/onprem/signaling`,
      openaiRealtimeUrl: `${mock.origin}/realtime/openai/v1`,
      openaiRealtimeModel: 'gpt-realtime-whisper',
      diarizationUrl: null,
      diarizationModel: null
    }
  }
  const context = (overrides: Record<string, unknown> = {}): { runtime: never; storage: null } => ({
    runtime: { ...runtime(), config: { ...runtime().config, ...overrides } } as never,
    storage: null
  })

  it('recognises a test clip and gets a chat answer, beside the model lists', async () => {
    const asr = await testConnection({ target: 'asr' }, context())
    expect(asr).toMatchObject({
      ok: true,
      status: 200,
      finding: { kind: 'transcribed', model: 'jlu/whisper-1' },
      checks: [
        { kind: 'models', count: 2 },
        { kind: 'transcribed', model: 'jlu/whisper-1' }
      ],
      message: null
    })
    // A listed model the endpoint cannot run fails at the operation.
    expect(await testConnection({ target: 'asr', model: 'mock-fail' }, context())).toMatchObject({
      ok: false,
      status: 503,
      checks: [{ kind: 'models', count: 2 }]
    })
    expect(await testConnection({ target: 'llm', model: 'mock-chat' }, context())).toMatchObject({
      ok: true,
      checks: [
        { kind: 'models', count: 2 },
        { kind: 'chatAnswered', model: 'mock-chat' }
      ]
    })
    expect(await testConnection({ target: 'llm', model: 'mock-fail' }, context())).toMatchObject({
      ok: false,
      status: 500
    })
    expect(
      await testConnection({ target: 'llm' }, context({ llmModels: [], defaultSummaryModel: null }))
    ).toMatchObject({ ok: false, finding: { kind: 'noModel' } })
    expect(
      await testConnection(
        { target: 'diarization' },
        context({ diarizationUrl: `${mock.origin}/diarization/diarize` })
      )
    ).toMatchObject({ ok: true, finding: { kind: 'diarized', turns: 1 } })
  })

  it('fails an endpoint that lists the model but rejects the operation', async () => {
    const fetchMock = vi.fn(async (url: string | URL) =>
      String(url).endsWith('/models')
        ? Response.json({ data: [{ id: 'jlu/whisper-1' }, { id: 'chat' }] })
        : new Response('Not found', { status: 404 })
    )
    vi.stubGlobal('fetch', fetchMock)
    expect(await testConnection({ target: 'asr' }, context())).toMatchObject({
      ok: false,
      status: 404,
      checks: [{ kind: 'models', count: 2 }],
      message: 'Status 404: Not found'
    })
    expect(await testConnection({ target: 'llm', model: 'chat' }, context())).toMatchObject({
      ok: false,
      status: 404
    })
    // A speech endpoint without a model list is still tested by its operation.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) =>
        String(url).endsWith('/models')
          ? new Response('no', { status: 404 })
          : Response.json({ text: '', segments: [] })
      )
    )
    expect(await testConnection({ target: 'asr' }, context())).toMatchObject({
      ok: true,
      checks: [{ kind: 'modelsUnlisted' }, { kind: 'transcribed', model: 'jlu/whisper-1' }]
    })
  })

  it('rejects 2xx answers of the wrong shape', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) =>
        String(url).endsWith('/models')
          ? Response.json({ data: [{ id: 'jlu/whisper-1' }] })
          : new Response('<html>Login</html>', {
              status: 200,
              headers: { 'Content-Type': 'text/html' }
            })
      )
    )
    const invalid = (expected: string): Record<string, unknown> => ({
      ok: false,
      status: 200,
      finding: { kind: 'invalidAnswer', expected }
    })
    expect(await testConnection({ target: 'asr' }, context())).toMatchObject(
      invalid('transcription')
    )
    expect(
      await testConnection({ target: 'llm', model: 'jlu/whisper-1' }, context())
    ).toMatchObject(invalid('chat'))
    expect(
      await testConnection({ target: 'diarization', url: 'https://diarize.example/d' }, context())
    ).toMatchObject(invalid('diarization'))
    expect(await testConnection({ target: 'realtimeOnprem' }, context())).toMatchObject(
      invalid('sdpAnswer')
    )
    expect(await testConnection({ target: 'realtimeOpenai' }, context())).toMatchObject(
      invalid('clientSecret')
    )
  })

  it('tests the bridge with an offer and OpenAI with a key request, never echoing keys', async () => {
    expect(await testConnection({ target: 'realtimeOnprem' }, context())).toMatchObject({
      ok: true,
      finding: { kind: 'sdpAnswered' }
    })
    const openai = await testConnection({ target: 'realtimeOpenai' }, context())
    expect(openai).toMatchObject({
      ok: true,
      status: 200,
      finding: { kind: 'keyIssued', model: 'gpt-realtime-whisper' },
      message: null
    })
    expect(JSON.stringify(openai)).not.toMatch(/ek_mock|sk-openai/)
    const typedKeyOnly = await testConnection({ target: 'realtimeOpenai', apiKey: null }, context())
    expect(typedKeyOnly).toMatchObject({ ok: false, finding: { kind: 'notSetUp' } })
  })

  describe('storage', () => {
    /** A bucket in memory; signed URLs answer through the stubbed `fetch`. */
    function memoryStorage(): TestStorage & { objects: Map<string, string> } {
      const objects = new Map<string, string>()
      return {
        objects,
        bucket: 'test-bucket',
        presignUpload: async (key) => ({
          url: `https://storage.example/put/${encodeURIComponent(key)}`,
          method: 'PUT',
          headers: { 'Content-Type': 'text/plain' },
          expiresAt: new Date().toISOString()
        }),
        presignDownload: async (key) => ({
          url: `https://storage.example/get/${encodeURIComponent(key)}`,
          expiresAt: new Date().toISOString()
        }),
        put: async (key, body) =>
          void objects.set(key, new TextDecoder().decode(body as Uint8Array)),
        get: async (key) => Readable.from([Buffer.from(objects.get(key) ?? '')]),
        delete: async (key) => void objects.delete(key),
        head: async (key) => (objects.has(key) ? { size: 1, contentType: 'text/plain' } : null)
      }
    }
    function signedFetch(
      storage: { objects: Map<string, string> },
      tamper = false
    ): ReturnType<typeof vi.fn> {
      return vi.fn(async (url: string | URL, init?: RequestInit) => {
        const [, action, key] = /\/(put|get)\/(.+)$/.exec(String(url))!
        const decoded = decodeURIComponent(key!)
        if (action === 'put') {
          storage.objects.set(decoded, new TextDecoder().decode(init!.body as Uint8Array))
          return new Response(null, { status: 200 })
        }
        return new Response(tamper ? 'other' : (storage.objects.get(decoded) ?? ''), {
          status: 200
        })
      })
    }
    const storageContext = (storage: TestStorage): ConnectionContext => ({
      runtime: { ...runtime(), componentId: 'c1' } as never,
      storage
    })

    it('puts, reads back and deletes a test object through signed URLs', async () => {
      const storage = memoryStorage()
      const fetchMock = signedFetch(storage)
      vi.stubGlobal('fetch', fetchMock)
      const result = await testConnection({ target: 'storage' }, storageContext(storage))
      expect(result).toMatchObject({
        ok: true,
        finding: { kind: 'signedRoundTrip', bucket: 'test-bucket' }
      })
      expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(['PUT', 'GET'])
      expect(String(fetchMock.mock.calls[0]![0])).toContain('transcription%2Fc1%2Fconnection-tests')
      expect(storage.objects.size).toBe(0)
    })

    it('says when the server cannot reach the signed URLs, and catches wrong content', async () => {
      const storage = memoryStorage()
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new TypeError('fetch failed')
        })
      )
      expect(await testConnection({ target: 'storage' }, storageContext(storage))).toMatchObject({
        ok: true,
        checks: [
          { kind: 'signedUrlsUnreachable' },
          { kind: 'serverRoundTrip', bucket: 'test-bucket' }
        ]
      })
      vi.stubGlobal('fetch', signedFetch(storage, true))
      expect(await testConnection({ target: 'storage' }, storageContext(storage))).toMatchObject({
        ok: false,
        finding: { kind: 'invalidAnswer', expected: 'storedContent' }
      })
      expect(storage.objects.size).toBe(0)
      // A refused signature is a failure, not an unreachable endpoint.
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('SignatureDoesNotMatch', { status: 403 }))
      )
      expect(await testConnection({ target: 'storage' }, storageContext(storage))).toMatchObject({
        ok: false,
        status: 403
      })
    })
  })

  it('reports what is not set up, and storage without a bucket', async () => {
    expect(await testConnection({ target: 'diarization' }, context())).toMatchObject({
      ok: false,
      status: null,
      finding: { kind: 'notSetUp' }
    })
    expect(await testConnection({ target: 'storage' }, context())).toMatchObject({ ok: false })
  })

  it('masks a key the upstream repeats in its error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Invalid key sk-typed-1234 given', { status: 401 }))
    )
    const result = await testConnection(
      { target: 'diarization', url: 'https://diarize.example/diarize', apiKey: 'sk-typed-1234' },
      context()
    )
    expect(result).toMatchObject({
      ok: false,
      status: 401,
      message: 'Status 401: Invalid key *** given'
    })
  })

  it('answers through the route, validating the target', async () => {
    const app = testApp(adminRouter, { config: testConfig() as never, secrets: runtime().secrets })
    const response = await app.request(test, json('POST', { target: 'llm' }))
    expect(response.status).toBe(200)
    const body = await response.text()
    expect(JSON.parse(body)).toMatchObject({ ok: true, status: 200 })
    expect(JSON.parse(body).checks).toEqual([
      { kind: 'models', count: 2 },
      { kind: 'chatAnswered', model: 'mock-chat' }
    ])
    expect(body).not.toContain('sk-')
    expect((await app.request(test, json('POST', { target: 'nope' }))).status).toBe(400)
  })
})
