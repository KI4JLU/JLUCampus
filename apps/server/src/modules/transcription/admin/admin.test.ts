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
      onpremSignalingUrl: `${mock.origin}/realtime/bridge`,
      onpremRealtimeModel: 'voxtral-mini-realtime',
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

  it('tests a chat model configured by hand on an endpoint without a model list', async () => {
    const fetchMock = vi.fn(async (url: string | URL) =>
      String(url).endsWith('/models')
        ? new Response('Not found', { status: 404 })
        : Response.json({ choices: [{ message: { content: 'OK' } }] })
    )
    vi.stubGlobal('fetch', fetchMock)
    expect(await testConnection({ target: 'llm', model: 'manual-chat' }, context())).toMatchObject({
      ok: true,
      status: 200,
      checks: [{ kind: 'modelsUnlisted' }, { kind: 'chatAnswered', model: 'manual-chat' }],
      message: null
    })
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      `${mock.origin}/llm/v1/models`,
      `${mock.origin}/llm/v1/chat/completions`
    ])
    // A wrong key still fails, at the operation that decides.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Unauthorized', { status: 401 }))
    )
    expect(await testConnection({ target: 'llm', model: 'manual-chat' }, context())).toMatchObject({
      ok: false,
      status: 401,
      checks: [{ kind: 'modelsUnlisted' }],
      message: 'Status 401: Unauthorized'
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

  it('rejects 2xx answers that parse but are no result of the operation', async () => {
    // The review's counterexamples: each answered 200 and passed before.
    const answers: Record<string, () => Response> = {
      'audio/transcriptions': () => Response.json({ error: 'operation failed' }),
      'chat/completions': () => Response.json({ choices: [{ message: {} }] }),
      '/health': () => new Response('ok'),
      '/probe': () => Response.json({ ok: true }),
      '/bridge/realtime': () =>
        new Response('v=0\r\n', { headers: { 'Content-Type': 'application/sdp' } }),
      client_secrets: () => Response.json({ value: 'expired-key', expires_at: 1 })
    }
    const fetchMock = vi.fn(async (url: string | URL) => {
      const path = String(url)
      if (path.endsWith('/models')) return Response.json({ data: [{ id: 'jlu/whisper-1' }] })
      const match = Object.entries(answers).find(([suffix]) => path.endsWith(suffix))
      return match ? match[1]() : new Response('?', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
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
    expect(await testConnection({ target: 'realtimeOnprem' }, context())).toMatchObject(
      invalid('sdpAnswer')
    )
    const openai = await testConnection({ target: 'realtimeOpenai' }, context())
    expect(openai).toMatchObject(invalid('clientSecret'))
    expect(JSON.stringify(openai)).not.toMatch(/expired-key|sk-openai/)

    // Empty or thinking-only chat content is no answer either; unrelated JSON no transcription.
    answers['chat/completions'] = () =>
      Response.json({ choices: [{ message: { content: '<think>…</think> ' } }] })
    answers['audio/transcriptions'] = () => Response.json({ result: 'ok' })
    expect(await testConnection({ target: 'asr' }, context())).toMatchObject(
      invalid('transcription')
    )
    expect(
      await testConnection({ target: 'llm', model: 'jlu/whisper-1' }, context())
    ).toMatchObject(invalid('chat'))

    // Silence is a valid transcription: Whisper's shape with empty text.
    answers['audio/transcriptions'] = () =>
      Response.json({ task: 'transcribe', language: 'german', duration: 1, text: '', segments: [] })
    expect(await testConnection({ target: 'asr' }, context())).toMatchObject({
      ok: true,
      finding: { kind: 'transcribed' }
    })
  })

  it('offers the bridge what a browser offers and checks its answer against it', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=ice-ufrag:abcd\r\na=ice-pwd:abcdefghijklmnopqrstuvwx\r\na=fingerprint:sha-256 00:11\r\n'
      })
    )
    vi.stubGlobal('fetch', fetchMock)
    // One media section for the offer's audio and data channel.
    expect(await testConnection({ target: 'realtimeOnprem' }, context())).toMatchObject({
      ok: false,
      finding: { kind: 'invalidAnswer', expected: 'sdpAnswer' }
    })
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>
    expect(calls.map(([url]) => String(url))).toEqual([
      `${mock.origin}/realtime/bridge/health`,
      `${mock.origin}/realtime/bridge/probe`,
      `${mock.origin}/realtime/bridge/realtime`
    ])
    const init = calls[2]![1]
    const headers = new Headers(init.headers)
    // The bridge protocol: the offer as SDP, the gateway per request in headers.
    expect(headers.get('content-type')).toBe('application/sdp')
    expect(headers.get('x-gateway-base')).toBe(`${mock.origin}/asr`)
    expect(headers.get('x-gateway-key')).toBe('sk-speech-secret')
    expect(headers.get('x-model')).toBe('voxtral-mini-realtime')
    const sdp = String(init.body)
    for (const line of [
      /^m=audio 9 UDP\/TLS\/RTP\/SAVPF 111$/m,
      /^m=application 9 UDP\/DTLS\/SCTP webrtc-datachannel$/m,
      /^a=ice-ufrag:/m,
      /^a=ice-pwd:/m,
      /^a=fingerprint:sha-256 /m,
      /^a=setup:actpass$/m
    ]) {
      expect(sdp).toMatch(line)
    }
  })

  it('fails a bridge whose answer has every transport attribute but no usable value', async () => {
    const section = (media: string, mid: number): string[] => [
      media,
      'c=IN IP4 0.0.0.0',
      `a=mid:${mid}`,
      'a=ice-ufrag:',
      'a=ice-pwd:',
      'a=fingerprint:',
      'a=setup:passive'
    ]
    const sdp = [
      'v=0',
      'o=- 1 1 IN IP4 127.0.0.1',
      's=-',
      't=0 0',
      ...section('m=audio 9 UDP/TLS/RTP/SAVPF 111', 0),
      ...section('m=application 9 UDP/DTLS/SCTP webrtc-datachannel', 1),
      ''
    ].join('\r\n')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ sdp }))
    )
    expect(await testConnection({ target: 'realtimeOnprem' }, context())).toMatchObject({
      ok: false,
      status: 200,
      finding: { kind: 'invalidAnswer', expected: 'sdpAnswer' }
    })
  })

  it('tests the bridge with an offer and OpenAI with a key request, never echoing keys', async () => {
    const onprem = await testConnection({ target: 'realtimeOnprem' }, context())
    expect(onprem).toMatchObject({
      ok: true,
      finding: { kind: 'sdpAnswered' },
      checks: [
        { kind: 'bridgeReachable' },
        { kind: 'realtimeModelAccepted', model: 'voxtral-mini-realtime' },
        { kind: 'sdpAnswered' }
      ]
    })
    expect(JSON.stringify(onprem)).not.toContain('sk-speech-secret')
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

  it('says precisely why the on-prem path cannot run', async () => {
    // The mock gateway refuses `denied` models with 403, as the HRZ gateway refuses a realtime
    // model the key may not use; its model list works and lacks the model.
    const denied = await testConnection(
      { target: 'realtimeOnprem', model: 'voxtral-denied' },
      context()
    )
    expect(denied).toMatchObject({
      ok: false,
      status: 502,
      finding: { kind: 'realtimeUnavailable', reason: 'modelNotAllowed', model: 'voxtral-denied' },
      checks: [{ kind: 'bridgeReachable' }, { kind: 'realtimeUnavailable' }]
    })
    expect(JSON.stringify(denied)).not.toContain('sk-speech-secret')

    // The same refusal while the model list refuses the key too: the key is wrong.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const path = String(url)
        if (path.endsWith('/health')) return new Response('ok')
        if (path.endsWith('/models')) return new Response('Unauthorized', { status: 401 })
        return Response.json(
          { error: 'upstream_rejected', message: 'refused', upstream_status: 403 },
          { status: 502 }
        )
      })
    )
    expect(await testConnection({ target: 'realtimeOnprem' }, context())).toMatchObject({
      ok: false,
      finding: { kind: 'realtimeUnavailable', reason: 'gatewayKeyRejected' }
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) =>
        String(url).endsWith('/health')
          ? new Response('ok')
          : Response.json({ error: 'unauthorized', message: 'wrong key' }, { status: 401 })
      )
    )
    expect(await testConnection({ target: 'realtimeOnprem' }, context())).toMatchObject({
      finding: { kind: 'realtimeUnavailable', reason: 'bridgeKeyRejected' }
    })
    vi.unstubAllGlobals()

    expect(
      await testConnection({ target: 'realtimeOnprem', bridgeUrl: 'http://127.0.0.1:9' }, context())
    ).toMatchObject({
      ok: false,
      finding: { kind: 'realtimeUnavailable', reason: 'bridgeUnreachable' }
    })
    // Without a bridge, or without a gateway (no speech endpoint either), nothing to test.
    expect(
      await testConnection({ target: 'realtimeOnprem' }, context({ onpremSignalingUrl: null }))
    ).toMatchObject({ finding: { kind: 'notSetUp' } })
    expect(
      await testConnection({ target: 'realtimeOnprem' }, context({ asrBaseUrl: null }))
    ).toMatchObject({ finding: { kind: 'notSetUp' } })
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
