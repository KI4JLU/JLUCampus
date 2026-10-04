import { TRANSCRIPTION_API } from '@justcampus/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { json, startUpstreamMock, testApp, type RunningMock } from '../transcripts/testing.js'
import { realtimeRouter } from './index.js'
import { probeOffer, sdpAnswerProblem } from './sdp.js'
import { isTurnServer, sessionIceServers, turnCredential, TurnNotSetUpError } from './turn.js'
import { clientSecretRequest, parseClientSecret, parseSignalingAnswer } from './upstream.js'

const relative = (path: string): string => path.replace('/api/modules/transcription', '')

describe('upstream answers', () => {
  /** A bridge's answer to a two-section offer, credentials per section. */
  const answer = [
    'v=0',
    'o=bridge 1 1 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0 1',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'c=IN IP4 0.0.0.0',
    'a=mid:0',
    'a=ice-ufrag:abcd',
    'a=ice-pwd:abcdefghijklmnopqrstuvwx',
    'a=fingerprint:sha-256 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF',
    'a=setup:passive',
    'a=recvonly',
    'a=rtpmap:111 opus/48000/2',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    'a=mid:1',
    'a=ice-ufrag:abcd',
    'a=ice-pwd:abcdefghijklmnopqrstuvwx',
    'a=fingerprint:sha-256 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF',
    'a=setup:passive',
    'a=sctp-port:5000',
    ''
  ].join('\r\n')

  it('reads the bridge’s SDP answer as JSON or as SDP', () => {
    expect(parseSignalingAnswer(JSON.stringify({ sdp: answer }), 'application/json')).toBe(answer)
    expect(parseSignalingAnswer(JSON.stringify({ answer: { sdp: answer } }), null)).toBe(answer)
    expect(parseSignalingAnswer(answer, 'application/sdp', probeOffer())).toBe(answer)
    expect(() => parseSignalingAnswer('{"error": "busy"}', 'application/json')).toThrow(
      'without an SDP answer'
    )
    expect(() => parseSignalingAnswer('<html>', 'text/html')).toThrow()
  })

  it('refuses an SDP answer no WebRTC peer could use', () => {
    // Only the version line, as in the review's counterexample.
    expect(() => parseSignalingAnswer('v=0\r\n', 'application/sdp')).toThrow('unusable SDP')
    expect(sdpAnswerProblem('v=0\r\n')).toBe('no o= line')
    expect(sdpAnswerProblem(answer.replace(/^m=.*\r\n/gm, ''))).toBe('no media section')
    expect(sdpAnswerProblem(answer.replaceAll('a=fingerprint:', 'a=x-fingerprint:'))).toBe(
      'no fingerprint for audio'
    )
    expect(sdpAnswerProblem(answer.replaceAll('a=ice-pwd:', 'a=x-pwd:'))).toBe(
      'no ice-pwd for audio'
    )
    expect(sdpAnswerProblem(answer.replace('UDP/TLS/RTP/SAVPF', 'RTP/AVP'))).toMatch(
      /^not a WebRTC media section/
    )
    // One media section for an offer of two breaks RFC 3264.
    const audioOnly = answer.slice(0, answer.indexOf('m=application'))
    expect(sdpAnswerProblem(audioOnly, probeOffer())).toBe("1 media sections for the offer's 2")
    // Credentials for the whole session do; a rejected section (port 0) needs none.
    const sessionLevel = [
      'v=0',
      'o=- 1 1 IN IP4 127.0.0.1',
      's=-',
      't=0 0',
      'a=ice-ufrag:abcd',
      'a=ice-pwd:abcdefghijklmnopqrstuvwx',
      `a=fingerprint:sha-1 ${Array(20).fill('ab').join(':')}`,
      'a=setup:active',
      'm=audio 0 UDP/TLS/RTP/SAVPF 111',
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
      ''
    ].join('\r\n')
    expect(sdpAnswerProblem(sessionLevel, probeOffer())).toBeNull()
    expect(sdpAnswerProblem(sessionLevel.replace(' 9 UDP/DTLS', ' 0 UDP/DTLS'))).toBe(
      'every media section rejected'
    )
  })

  it('refuses transport values no WebRTC peer could negotiate with', () => {
    const problem = (from: string | RegExp, to: string): string | null =>
      sdpAnswerProblem(answer.replaceAll(from, to), probeOffer())
    // The review's counterexample: every attribute there, every value empty.
    expect(problem(/^a=(ice-ufrag|ice-pwd|fingerprint):.*$/gm, 'a=$1:')).toBe(
      'invalid ice-ufrag for audio: '
    )
    expect(problem('a=ice-ufrag:abcd', 'a=ice-ufrag:abc')).toBe('invalid ice-ufrag for audio: abc')
    expect(problem('a=ice-ufrag:abcd', 'a=ice-ufrag:ab cd')).toMatch(/^invalid ice-ufrag/)
    expect(problem('a=ice-pwd:abcdefghijklmnopqrstuvwx', 'a=ice-pwd:short')).toBe(
      'invalid ice-pwd for audio: short'
    )
    expect(problem('a=fingerprint:sha-256 ', 'a=fingerprint:')).toMatch(/^invalid fingerprint/)
    expect(problem('a=fingerprint:sha-256 ', 'a=fingerprint:sha-999 ')).toMatch(
      /^invalid fingerprint/
    )
    // Too few bytes for SHA-256, and no hex.
    expect(problem(/ 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:/g, ' 00:')).toMatch(
      /^invalid fingerprint/
    )
    expect(problem(/AA:BB/g, 'XX:YY')).toMatch(/^invalid fingerprint/)
    // The answerer takes a DTLS role; `actpass` is the offerer's, and none is none.
    expect(problem('a=setup:passive', 'a=setup:actpass')).toBe('invalid setup for audio: actpass')
    expect(problem('a=setup:passive', 'a=setup:holdconn')).toMatch(/^invalid setup/)
    expect(problem('a=setup:passive\r\n', '')).toBe('no setup for audio')
    expect(problem('a=setup:passive', 'a=setup:active')).toBeNull()
    expect(problem(/AA:BB:CC:DD:EE:FF/g, 'aa:bb:cc:dd:ee:ff')).toBeNull()
  })

  it('takes bundled transport from the section that carries it', () => {
    // RFC 8843: the answer may give transport only in the BUNDLE-tagged section.
    const [head, data] = answer.split('m=application')
    const bundled = `${head}m=application${data!.replace(
      /^a=(ice-ufrag|ice-pwd|fingerprint|setup):.*\r\n/gm,
      ''
    )}`
    expect(sdpAnswerProblem(bundled, probeOffer())).toBeNull()
    // Without the group the data channel has no transport of its own.
    expect(sdpAnswerProblem(bundled.replace('a=group:BUNDLE 0 1\r\n', ''), probeOffer())).toBe(
      'no ice-ufrag for application'
    )
  })

  it('makes a fresh, browser-like offer that a WebRTC peer accepts and answers', async () => {
    const offer = probeOffer()
    expect(offer).toMatch(/^m=audio 9 UDP\/TLS\/RTP\/SAVPF 111$/m)
    expect(offer).toMatch(/^m=application 9 UDP\/DTLS\/SCTP webrtc-datachannel$/m)
    expect(offer).toMatch(/^a=ice-ufrag:\w{4}$/m)
    expect(offer).toMatch(/^a=ice-pwd:\w{24}$/m)
    expect(offer).toMatch(/^a=fingerprint:sha-256 ([0-9A-F]{2}:){31}[0-9A-F]{2}$/m)
    expect(offer).toMatch(/^a=setup:actpass$/m)
    // Every test has its own credentials, as every browser session has.
    expect(probeOffer().match(/a=ice-pwd:.*/)?.[0]).not.toBe(offer.match(/a=ice-pwd:.*/)?.[0])

    const { RTCPeerConnection } = await import('werift')
    const peer = new RTCPeerConnection()
    try {
      await peer.setRemoteDescription({ type: 'offer', sdp: offer })
      const local = await peer.createAnswer()
      expect(local.sdp).toContain('m=audio')
      expect(local.sdp).toContain('webrtc-datachannel')
      expect(sdpAnswerProblem(local.sdp, offer)).toBeNull()
      // The same answer with empty transport values is one no peer takes, nor this check.
      const emptied = local.sdp.replace(/^a=(ice-ufrag|ice-pwd|fingerprint):.*$/gm, 'a=$1:')
      expect(sdpAnswerProblem(emptied, offer)).toMatch(/^invalid ice-ufrag/)
    } finally {
      await peer.close()
    }
  })

  it('reads ephemeral keys of either answer shape, unless expired', () => {
    const now = new Date('2026-10-04T10:00:00.000Z')
    expect(parseClientSecret({ value: 'ek_1', expires_at: 1_800_000_000 }, now)).toEqual({
      value: 'ek_1',
      expiresAt: '2027-01-15T08:00:00.000Z'
    })
    expect(parseClientSecret({ client_secret: { value: 'ek_2' } }, now)).toEqual({
      value: 'ek_2',
      expiresAt: null
    })
    expect(() => parseClientSecret({}, now)).toThrow()
    expect(() => parseClientSecret({ value: 'expired-key', expires_at: 1 }, now)).toThrow('expired')
    expect(() =>
      parseClientSecret({ value: 'ek_3', expires_at: now.getTime() / 1000 }, now)
    ).toThrow('expired')
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
      json('POST', { sdp: probeOffer() })
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
    // An offer without ICE credentials or fingerprint is refused as a real bridge refuses it,
    // not answered with a stand-in.
    const bare = [
      'v=0',
      'o=- 0 0 IN IP4 127.0.0.1',
      's=-',
      't=0 0',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      'c=IN IP4 0.0.0.0',
      'a=mid:0',
      'a=sendonly',
      'a=rtpmap:111 opus/48000/2',
      ''
    ].join('\r\n')
    const unnegotiable = await testApp(realtimeRouter, config).request(
      relative(TRANSCRIPTION_API.realtimeOnpremSignaling),
      json('POST', { sdp: bare })
    )
    expect(unnegotiable.status).toBe(502)
    const missing = await testApp(realtimeRouter).request(
      relative(TRANSCRIPTION_API.realtimeOnpremSignaling),
      json('POST', { sdp: probeOffer() })
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
      body: probeOffer()
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
