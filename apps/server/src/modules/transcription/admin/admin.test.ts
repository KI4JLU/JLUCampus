import { TRANSCRIPTION_API } from '@justcampus/shared'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { json, startUpstreamMock, testApp, type RunningMock } from '../transcripts/testing.js'
import { chatModels, safeMessage, silentWav, testConnection } from './connections.js'
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

  it('checks speech and chat endpoints and the chosen model', async () => {
    expect(await testConnection({ target: 'asr' }, context())).toMatchObject({
      ok: true,
      status: 200
    })
    expect(await testConnection({ target: 'asr', model: 'other' }, context())).toMatchObject({
      ok: false,
      message: 'The endpoint does not list the model other'
    })
    expect(await testConnection({ target: 'llm', model: 'mock-chat' }, context())).toMatchObject({
      ok: true
    })
  })

  it('tests the bridge with an offer and OpenAI with a key request, never echoing keys', async () => {
    expect(await testConnection({ target: 'realtimeOnprem' }, context())).toMatchObject({
      ok: true
    })
    const openai = await testConnection({ target: 'realtimeOpenai' }, context())
    expect(openai).toMatchObject({ ok: true, status: 200, message: null })
    expect(JSON.stringify(openai)).not.toMatch(/ek_mock|sk-openai/)
    const typedKeyOnly = await testConnection({ target: 'realtimeOpenai', apiKey: null }, context())
    expect(typedKeyOnly).toMatchObject({ ok: false, message: 'The OpenAI key is not set up' })
  })

  it('reports what is not set up, and storage without a bucket', async () => {
    expect(await testConnection({ target: 'diarization' }, context())).toMatchObject({
      ok: false,
      status: null,
      message: 'The diarisation endpoint is not set up'
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
    expect(body).not.toContain('sk-')
    expect((await app.request(test, json('POST', { target: 'nope' }))).status).toBe(400)
  })
})
