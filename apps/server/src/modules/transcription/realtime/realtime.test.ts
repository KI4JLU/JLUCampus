import { TRANSCRIPTION_API } from '@justcampus/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { TEST_SDP_OFFER } from '../admin/connections.js'
import { json, startUpstreamMock, testApp, type RunningMock } from '../transcripts/testing.js'
import { realtimeRouter } from './index.js'
import { isTurnServer, sessionIceServers, turnCredential, TurnNotSetUpError } from './turn.js'
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

describe('TURN credentials', () => {
  const servers = [
    { urls: ['stun:stun.example.org:3478'] },
    { urls: ['turn:turn.example.org:3478', 'turns:turn.example.org:5349'] }
  ]
  const now = new Date('2026-10-04T10:00:00.000Z')

  it("makes coturn's REST API credentials, which expire", () => {
    // The user name is the expiry; the credential is HMAC-SHA1 over it with the shared secret.
    expect(turnCredential('north-secret-0123456789', new Date('2026-10-04T11:00:00Z'))).toEqual({
      username: '1791111600:jlu-campus',
      credential: 'T+LYWxPquutvrASIQQkkxtjzbEY='
    })
    expect(isTurnServer(['stun:a', ' TURNS:b'])).toBe(true)
    expect(isTurnServer(['stun:a'])).toBe(false)
  })

  it('gives TURN servers credentials for one session only when configured', () => {
    const config = { realtimeIceServers: servers, realtimeTurnCredentialSeconds: 600 }
    expect(
      sessionIceServers({ ...config, realtimeTurnAuth: 'none' }, 'north-secret-0123456789', now)
    ).toEqual({ iceServers: servers, expiresAt: null })
    const ice = sessionIceServers(
      { ...config, realtimeTurnAuth: 'ephemeral' },
      'north-secret-0123456789',
      now
    )
    expect(ice.expiresAt).toBe('2026-10-04T10:10:00.000Z')
    expect(ice.iceServers[0]).toEqual({ urls: ['stun:stun.example.org:3478'] })
    expect(ice.iceServers[1]).toMatchObject({
      urls: servers[1]!.urls,
      username: '1791108600:jlu-campus',
      credential: expect.any(String)
    })
    expect(JSON.stringify(ice)).not.toContain('north-secret')
    expect(() =>
      sessionIceServers({ ...config, realtimeTurnAuth: 'ephemeral' }, undefined, now)
    ).toThrow(TurnNotSetUpError)
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

  it('hands out the on-prem ICE servers per session, uncached', async () => {
    const response = await testApp(realtimeRouter, config).request(
      relative(TRANSCRIPTION_API.realtimeIceServers),
      { method: 'POST' }
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      iceServers: [{ urls: ['stun:stun.example.org:3478'] }],
      expiresAt: null
    })
    // TURN credentials wanted, but the server has no shared secret: a clear failure.
    const unset = await testApp(realtimeRouter, {
      ...config,
      config: {
        ...config!.config,
        realtimeIceServers: [{ urls: ['turn:turn.example.org:3478'] }],
        realtimeTurnAuth: 'ephemeral'
      }
    }).request(relative(TRANSCRIPTION_API.realtimeIceServers), { method: 'POST' })
    expect(unset.status).toBe(502)
    const missing = await testApp(realtimeRouter).request(
      relative(TRANSCRIPTION_API.realtimeIceServers),
      { method: 'POST' }
    )
    expect(missing.status).toBe(502)
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

  it('connects a real peer through the server to the mock bridge, which transcribes', async () => {
    const { MediaStreamTrack, RTCPeerConnection, RtpHeader, RtpPacket } = await import('werift')
    const peer = new RTCPeerConnection()
    const track = new MediaStreamTrack({ kind: 'audio' })
    peer.addTransceiver(track, { direction: 'sendonly' })
    const channel = peer.createDataChannel('oai-events')
    const events: Array<{ type: string; delta?: string; transcript?: string }> = []
    channel.onMessage.subscribe((data) => events.push(JSON.parse(String(data))))
    await peer.setLocalDescription(await peer.createOffer())
    await vi.waitFor(() => expect(peer.iceGatheringState).toBe('complete'), { timeout: 5000 })
    try {
      const response = await testApp(realtimeRouter, config).request(
        relative(TRANSCRIPTION_API.realtimeOnpremSignaling),
        json('POST', { sdp: peer.localDescription!.sdp })
      )
      const { sdp } = (await response.json()) as { sdp: string }
      expect(sdp).toMatch(/^a=fingerprint:/m)
      await peer.setRemoteDescription({ type: 'answer', sdp })
      await vi.waitFor(() => expect(channel.readyState).toBe('open'), { timeout: 10_000 })
      for (let sequenceNumber = 0; sequenceNumber < 10; sequenceNumber++) {
        const header = new RtpHeader({
          payloadType: 111,
          sequenceNumber,
          timestamp: 960 * sequenceNumber
        })
        track.writeRtp(new RtpPacket(header, Buffer.alloc(20)))
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
      // Stopping on-prem: the bridge finishes the audio so far.
      channel.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
      await vi.waitFor(
        () =>
          expect(events.at(-1)?.type).toBe('conversation.item.input_audio_transcription.completed'),
        { timeout: 5000 }
      )
      const deltas = events.flatMap((event) => (event.delta === undefined ? [] : [event.delta]))
      expect(events[0]?.type).toBe('input_audio_buffer.committed')
      expect(deltas.join('')).toBe(events.at(-1)?.transcript)
      expect(events.at(-1)?.transcript).toBe('Guten Morgen und willkommen zur Live-Transkription.')
    } finally {
      await peer.close()
    }
  }, 20_000)

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
