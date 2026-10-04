import { TRANSCRIPTION_API } from '@justcampus/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { TEST_SDP_OFFER } from '../admin/connections.js'
import { json, startUpstreamMock, testApp, type RunningMock } from '../transcripts/testing.js'
import { realtimeRouter } from './index.js'
import { clientSecretRequest, parseClientSecret, parseSignalingAnswer } from './upstream.js'

const relative = (path: string): string => path.replace('/api/modules/transcription', '')

describe('upstream answers', () => {
  it('reads the bridge’s SDP answer as JSON or as SDP', () => {
    expect(parseSignalingAnswer('{"sdp": "v=0\\r\\no=- 1"}', 'application/json')).toBe(
      'v=0\r\no=- 1'
    )
    expect(parseSignalingAnswer('{"answer": {"sdp": "v=0\\no=x"}}', null)).toBe('v=0\no=x')
    expect(parseSignalingAnswer('v=0\r\ns=-\r\n', 'application/sdp')).toBe('v=0\r\ns=-\r\n')
    expect(() => parseSignalingAnswer('{"error": "busy"}', 'application/json')).toThrow(
      'without an SDP answer'
    )
    expect(() => parseSignalingAnswer('<html>', 'text/html')).toThrow()
  })

  it('reads ephemeral keys of either answer shape', () => {
    expect(parseClientSecret({ value: 'ek_1', expires_at: 1_800_000_000 })).toEqual({
      value: 'ek_1',
      expiresAt: '2027-01-15T08:00:00.000Z'
    })
    expect(parseClientSecret({ client_secret: { value: 'ek_2' } })).toEqual({
      value: 'ek_2',
      expiresAt: null
    })
    expect(() => parseClientSecret({})).toThrow()
  })

  it('asks for a transcription session with the admin’s model', () => {
    expect(clientSecretRequest('gpt-realtime-whisper')).toMatchObject({
      session: {
        type: 'transcription',
        audio: { input: { transcription: { model: 'gpt-realtime-whisper' } } }
      }
    })
  })
})

describe('realtime routes', () => {
  let mock: RunningMock
  let config: Parameters<typeof testApp>[1]
  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mock = await startUpstreamMock()
    config = {
      config: {
        realtimeModes: ['openai', 'onprem'],
        defaultRealtimeMode: 'onprem',
        onpremSignalingUrl: `${mock.origin}/realtime/onprem/signaling`,
        realtimeIceServers: [{ urls: ['stun:stun.example.org:3478'] }],
        openaiRealtimeUrl: `${mock.origin}/realtime/openai/v1`
      },
      secrets: { openaiRealtimeApiKey: 'sk-admin-secret' }
    }
  })
  afterAll(async () => {
    await mock.close()
    vi.restoreAllMocks()
  })

  it('offers the modes that are set up, with the default', async () => {
    const response = await testApp(realtimeRouter, config).request(
      relative(TRANSCRIPTION_API.realtimeConfig)
    )
    expect(await response.json()).toEqual({
      modes: ['openai', 'onprem'],
      defaultMode: 'onprem',
      iceServers: [{ urls: ['stun:stun.example.org:3478'] }],
      openaiModel: 'gpt-realtime-whisper'
    })
    const withoutKey = await testApp(realtimeRouter, {
      config: config!.config,
      secrets: { openaiRealtimeApiKey: null }
    }).request(relative(TRANSCRIPTION_API.realtimeConfig))
    expect(await withoutKey.json()).toMatchObject({ modes: ['onprem'], openaiModel: null })
    const none = await testApp(realtimeRouter).request(relative(TRANSCRIPTION_API.realtimeConfig))
    expect(await none.json()).toEqual({
      modes: [],
      defaultMode: null,
      iceServers: [],
      openaiModel: null
    })
  })

  it('passes the offer to the on-prem bridge and its answer back', async () => {
    const response = await testApp(realtimeRouter, config).request(
      relative(TRANSCRIPTION_API.realtimeOnpremSignaling),
      json('POST', { sdp: TEST_SDP_OFFER })
    )
    expect(response.status).toBe(200)
    const { sdp } = (await response.json()) as { sdp: string }
    expect(sdp).toMatch(/^v=0\r\n/)
    expect(sdp).toContain('a=mid:0')
    expect(sdp).toContain('a=recvonly')
    expect(sdp).toContain('m=application 9 UDP/DTLS/SCTP webrtc-datachannel')
  })

  it('reports a refused offer or a missing bridge as unavailable', async () => {
    const refused = await testApp(realtimeRouter, config).request(
      relative(TRANSCRIPTION_API.realtimeOnpremSignaling),
      json('POST', { sdp: 'not sdp' })
    )
    expect(refused.status).toBe(502)
    const missing = await testApp(realtimeRouter).request(
      relative(TRANSCRIPTION_API.realtimeOnpremSignaling),
      json('POST', { sdp: TEST_SDP_OFFER })
    )
    expect(missing.status).toBe(502)
    const empty = await testApp(realtimeRouter, config).request(
      relative(TRANSCRIPTION_API.realtimeOnpremSignaling),
      json('POST', { sdp: '' })
    )
    expect(empty.status).toBe(400)
  })

  it('issues an ephemeral key that works for the calls URL, never the admin’s key', async () => {
    const response = await testApp(realtimeRouter, config).request(
      relative(TRANSCRIPTION_API.realtimeSession),
      { method: 'POST' }
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const text = await response.text()
    expect(text).not.toContain('sk-admin-secret')
    const session = JSON.parse(text) as { value: string; callsUrl: string; model: string }
    expect(session).toMatchObject({
      value: expect.stringMatching(/^ek_mock_\d+$/),
      callsUrl: `${mock.origin}/realtime/openai/v1/realtime/calls`,
      model: 'gpt-realtime-whisper'
    })
    const call = await fetch(session.callsUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp', Authorization: `Bearer ${session.value}` },
      body: TEST_SDP_OFFER
    })
    expect(call.status).toBe(201)
    expect(await call.text()).toMatch(/^v=0\r\n/)
  })

  it('reports OpenAI as unavailable without a key', async () => {
    const response = await testApp(realtimeRouter, {
      config: config!.config,
      secrets: { openaiRealtimeApiKey: null }
    }).request(relative(TRANSCRIPTION_API.realtimeSession), { method: 'POST' })
    expect(response.status).toBe(502)
  })
})
