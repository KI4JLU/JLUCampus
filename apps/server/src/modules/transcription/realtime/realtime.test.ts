import { EventEmitter } from 'node:events'
import { createServer as createHttpServer, type Server } from 'node:http'
import { createServer as createNetServer, connect as netConnect, type Socket } from 'node:net'
import type { AddressInfo } from 'node:net'

import { serve } from '@hono/node-server'
import {
  TRANSCRIPTION_API,
  TRANSCRIPTION_DEFAULT_CONFIG,
  TRANSCRIPTION_LIVE_MESSAGE_MAX_BYTES,
  type TranscriptionComponentConfig
} from '@justcampus/shared'
import { Hono } from 'hono'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'

import { createWebSocketServer } from '../../../websocket.js'
import type { AppEnvironment } from '../../types.js'
import { forgetKeys } from '../http.js'
import {
  COMPONENT_ID,
  NO_SECRETS,
  startUpstreamMock,
  testApp,
  type RunningMock
} from '../transcripts/testing.js'
import {
  forgetAvailability,
  GatewayRefused,
  GatewayUnreachable,
  openGateway,
  probeGateway,
  proxyFor,
  realtimeAvailability,
  realtimeTarget,
  unavailableReason,
  type RealtimeTarget
} from './gateway.js'
import { realtimeRouter } from './index.js'
import {
  base64Bytes,
  openaiTurnDetection,
  parseClientEvent,
  readUpstreamEvent,
  realtimeSocketUrl,
  sessionUpdate
} from './protocol.js'
import {
  CLOSE,
  DEFAULT_LIVE_LIMITS,
  LiveSession,
  SessionSlots,
  type ClientSocket,
  type LiveLimits
} from './relay.js'

const relative = (path: string): string => path.replace('/api/modules/transcription', '')

/** `ms` of silence as base64 PCM16 at `rate`. */
function silence(ms: number, rate = 16_000): string {
  return Buffer.alloc(((rate * 2) / 1000) * ms).toString('base64')
}

function append(ms: number, rate = 16_000): string {
  return JSON.stringify({ type: 'input_audio_buffer.append', audio: silence(ms, rate) })
}

const COMMIT = JSON.stringify({ type: 'input_audio_buffer.commit' })
const KEEP_OPEN = JSON.stringify({ type: 'input_audio_buffer.commit', keep_open: true })

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > until) throw new Error('Timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('the live protocol', () => {
  it('takes appends of whole samples in canonical base64, up to a second', () => {
    expect(parseClientEvent(append(100), 'onprem')).toEqual({
      type: 'append',
      audio: silence(100),
      bytes: 3200
    })
    expect(parseClientEvent(append(1000), 'onprem')).toMatchObject({ bytes: 32_000 })
    expect(parseClientEvent(append(1001), 'onprem')).toBeNull()
    expect(parseClientEvent(append(1000, 24_000), 'openai')).toMatchObject({ bytes: 48_000 })
    const event = (audio: unknown): string =>
      JSON.stringify({ type: 'input_audio_buffer.append', audio })
    // Not base64, not canonical, an odd byte, nothing, no string.
    expect(parseClientEvent(event('ab$d'), 'onprem')).toBeNull()
    expect(parseClientEvent(event('abc'), 'onprem')).toBeNull()
    expect(parseClientEvent(event('AA=='), 'onprem')).toBeNull()
    expect(parseClientEvent(event(''), 'onprem')).toBeNull()
    expect(parseClientEvent(event(42), 'onprem')).toBeNull()
    expect(base64Bytes('AAAA')).toBe(3)
    expect(base64Bytes('AA==')).toBe(1)
  })

  it('takes only canonical base64: the bits the padding leaves unused are zero (W-10)', () => {
    const event = (audio: string): string =>
      JSON.stringify({ type: 'input_audio_buffer.append', audio })
    // Two bytes: `AAA=` is what encoding them gives, `AAB=` decodes to the same and is refused.
    expect(Buffer.from(Buffer.from('AAB=', 'base64')).toString('base64')).toBe('AAA=')
    expect(base64Bytes('AAA=')).toBe(2)
    expect(base64Bytes('AAB=')).toBeNull()
    expect(base64Bytes('AAD=')).toBeNull()
    expect(parseClientEvent(event('AAA='), 'onprem')).toMatchObject({ bytes: 2 })
    expect(parseClientEvent(event('AAB='), 'onprem')).toBeNull()
    expect(parseClientEvent(event('AQB='), 'onprem')).toBeNull()
    expect(parseClientEvent(event(Buffer.from([1, 2, 3, 4]).toString('base64')), 'onprem')).toEqual(
      { type: 'append', audio: 'AQIDBA==', bytes: 4 }
    )
    // One byte: four unused bits.
    expect(base64Bytes('AQ==')).toBe(1)
    expect(base64Bytes('AR==')).toBeNull()
    expect(base64Bytes('AY==')).toBeNull()
    // Every whole-sample encoding is taken as it is.
    for (let bytes = 2; bytes <= 64; bytes += 2) {
      const audio = Buffer.from(Array.from({ length: bytes }, (_, index) => index * 37)).toString(
        'base64'
      )
      expect(base64Bytes(audio)).toBe(bytes)
    }
  })

  it('takes commits, ignores session updates and refuses everything else', () => {
    expect(parseClientEvent(COMMIT, 'onprem')).toEqual({ type: 'commit', keepOpen: false })
    expect(parseClientEvent(KEEP_OPEN, 'onprem')).toEqual({ type: 'commit', keepOpen: true })
    expect(parseClientEvent('{"type":"session.update","model":"x"}', 'onprem')).toEqual({
      type: 'ignored'
    })
    expect(parseClientEvent('{"type":"response.create"}', 'onprem')).toBeNull()
    expect(parseClientEvent('{"type":"conversation.item.create"}', 'openai')).toBeNull()
    expect(parseClientEvent('not json', 'onprem')).toBeNull()
    expect(parseClientEvent('[1]', 'onprem')).toBeNull()
  })

  it('addresses each gateway as its protocol wants', () => {
    expect(realtimeSocketUrl('onprem', 'https://api.hrz.example/v1/', 'voxtral mini')).toBe(
      'wss://api.hrz.example/v1/realtime?model=voxtral%20mini'
    )
    expect(realtimeSocketUrl('onprem', 'http://localhost:9200/realtime/v1', 'm')).toBe(
      'ws://localhost:9200/realtime/v1/realtime?model=m'
    )
    expect(realtimeSocketUrl('openai', 'https://api.openai.com/v1', 'gpt')).toBe(
      'wss://api.openai.com/v1/realtime?intent=transcription'
    )
    // vLLM wants the model at the top level, OpenAI a transcription session with PCM at 24 kHz.
    expect(sessionUpdate('onprem', 'voxtral')).toEqual({ type: 'session.update', model: 'voxtral' })
    expect(sessionUpdate('openai', 'gpt')).toMatchObject({
      session: {
        type: 'transcription',
        audio: {
          input: { format: { type: 'audio/pcm', rate: 24_000 }, transcription: { model: 'gpt' } }
        }
      }
    })
  })

  it('sets OpenAI’s turn detection per model: none for gpt-realtime-whisper (W-1)', () => {
    const input = (model: string): Record<string, unknown> =>
      (sessionUpdate('openai', model) as { session: { audio: { input: Record<string, unknown> } } })
        .session.audio.input
    // The default model: turn detection `null`, the server commits itself.
    expect(TRANSCRIPTION_DEFAULT_CONFIG.openaiRealtimeModel).toBe('gpt-realtime-whisper')
    expect(input('gpt-realtime-whisper')).toEqual({
      format: { type: 'audio/pcm', rate: 24_000 },
      transcription: { model: 'gpt-realtime-whisper' },
      turn_detection: null
    })
    expect(input('gpt-realtime-whisper-2026-09-01').turn_detection).toBeNull()
    expect(openaiTurnDetection('gpt-realtime-whisper')).toBeNull()
    // Models with voice detection keep it.
    expect(input('gpt-4o-transcribe').turn_detection).toEqual({ type: 'server_vad' })
    expect(input('gpt-4o-mini-transcribe').turn_detection).toEqual({ type: 'server_vad' })
    expect(openaiTurnDetection('gpt-realtime-whisperish')).toBe('server_vad')
  })

  it('reads only transcript text from the gateway, and of errors only their code', () => {
    expect(readUpstreamEvent('onprem', '{"type":"transcription.delta","delta":"Hallo"}')).toEqual({
      type: 'delta',
      itemId: null,
      delta: 'Hallo'
    })
    expect(
      readUpstreamEvent('onprem', '{"type":"transcription.done","text":"Hallo Welt"}')
    ).toEqual({ type: 'completed', itemId: null, transcript: 'Hallo Welt' })
    expect(
      readUpstreamEvent('onprem', '{"type":"error","error":{"message":"Bearer sk-1","code":"x"}}')
    ).toEqual({ type: 'error', code: 'x', eventId: null })
    // The id of the server's event that caused an error, so a commit's answer is told apart.
    expect(
      readUpstreamEvent(
        'openai',
        '{"type":"error","error":{"code":"input_audio_buffer_commit_empty","event_id":"final_3"}}'
      )
    ).toEqual({ type: 'error', code: 'input_audio_buffer_commit_empty', eventId: 'final_3' })
    expect(
      readUpstreamEvent(
        'openai',
        '{"type":"conversation.item.input_audio_transcription.completed","item_id":"item_1","transcript":"Hi","logprobs":[]}'
      )
    ).toEqual({ type: 'completed', itemId: 'item_1', transcript: 'Hi' })
    expect(
      readUpstreamEvent('openai', '{"type":"input_audio_buffer.committed","item_id":"<script>"}')
    ).toBeNull()
    expect(
      readUpstreamEvent(
        'onprem',
        JSON.stringify({ type: 'transcription.delta', delta: 'x'.repeat(9000) })
      )
    ).toMatchObject({ delta: 'x'.repeat(4000) })
    expect(readUpstreamEvent('onprem', '{"type":"response.created"}')).toBeNull()
    expect(readUpstreamEvent('onprem', 'garbage')).toBeNull()
  })
})

/**
 * A browser's socket for `LiveSession`: what it got, how it was closed. Its close reaches the
 * session (`onClose`) as the route's `onClose` does, unless it is `stuck`.
 */
class FakeClient implements ClientSocket {
  readonly events: Record<string, unknown>[] = []
  closed: { code: number; reason: string } | null = null
  terminated = false
  bufferedAmount = 0
  stuck = false
  onClose: ((code: number) => void) | null = null
  private gone = false

  send(data: string): void {
    this.events.push(JSON.parse(data) as Record<string, unknown>)
  }

  close(code: number, reason: string): void {
    this.closed ??= { code, reason }
    if (!this.stuck) setImmediate(() => this.finish(code))
  }

  terminate(): void {
    this.terminated = true
    setImmediate(() => this.finish(1006))
  }

  private finish(code: number): void {
    if (this.gone) return
    this.gone = true
    this.onClose?.(code)
  }

  of(type: string): Record<string, unknown>[] {
    return this.events.filter((event) => event.type === type)
  }

  get errorCodes(): unknown[] {
    return this.of('error').map((event) => (event.error as { code: unknown }).code)
  }

  get text(): string {
    return this.of('conversation.item.input_audio_transcription.delta')
      .map((event) => event.delta)
      .join('')
  }
}

const FAST: Partial<LiveLimits> = { watchIntervalMs: 20, closeMs: 200 }

describe('live sessions against the mock gateway', () => {
  let mock: RunningMock
  let logged: string[]
  const key = 'sk-campus-review-sentinel-0123456789'

  beforeAll(async () => {
    mock = await startUpstreamMock()
  })
  afterAll(() => mock.close())
  beforeEach(() => {
    forgetAvailability()
    forgetKeys()
    logged = []
  })

  function target(mode: 'onprem' | 'openai', model?: string): RealtimeTarget {
    const config: TranscriptionComponentConfig = {
      ...TRANSCRIPTION_DEFAULT_CONFIG,
      onpremGatewayUrl: `${mock.origin}/realtime/v1`,
      openaiRealtimeUrl: `${mock.origin}/realtime/openai/v1`,
      ...(model && mode === 'onprem' ? { onpremRealtimeModel: model } : {}),
      ...(model && mode === 'openai' ? { openaiRealtimeModel: model } : {})
    }
    return realtimeTarget(mode, config, { apiKey: key, openaiRealtimeApiKey: key })!
  }

  function session(
    mode: 'onprem' | 'openai',
    options: { model?: string; limits?: Partial<LiveLimits> } = {}
  ): { client: FakeClient; live: LiveSession; ended: () => boolean } {
    const client = new FakeClient()
    let ended = 0
    const live = new LiveSession({
      target: target(mode, options.model),
      client,
      onEnd: () => {
        ended += 1
      },
      limits: { ...FAST, ...options.limits },
      log: (event, fields) => logged.push(`${event} ${JSON.stringify(fields ?? {})}`)
    })
    client.onClose = (code) => live.clientClosed(code)
    return { client, live, ended: () => ended === 1 }
  }

  it('relays on-prem audio and transcripts, and finishes the item on stop', async () => {
    const { client, live, ended } = session('onprem')
    await live.start()
    expect(client.events[0]).toEqual({
      type: 'session.created',
      session: { mode: 'onprem', sample_rate: 16_000 }
    })
    // Decoding starts after 300 ms: the browser learns which item to wait for.
    live.receive(append(100))
    live.receive(append(100))
    expect(client.of('input_audio_buffer.committed')).toHaveLength(0)
    live.receive(append(100))
    expect(client.of('input_audio_buffer.committed')).toEqual([
      { type: 'input_audio_buffer.committed', item_id: `item_${live.id}` }
    ])
    for (let index = 0; index < 30; index += 1) live.receive(append(100))
    await waitFor(() => client.text.includes('Live-Transkription.'))
    live.receive(COMMIT)
    await waitFor(() => client.closed !== null)
    const [completed] = client.of('conversation.item.input_audio_transcription.completed')
    expect(completed).toMatchObject({ item_id: `item_${live.id}` })
    expect(completed!.transcript).toBe(client.text)
    expect(client.closed).toEqual({ code: CLOSE.normal, reason: 'done' })
    await waitFor(ended)
  })

  it('never passes on or logs what the gateway says in its errors (B-1, D-1)', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { client, live } = session('onprem', { model: 'mock-realtime-leak' })
      await live.start()
      live.receive(append(400))
      await waitFor(
        () => client.of('conversation.item.input_audio_transcription.failed').length > 0
      )
      live.receive(COMMIT)
      await waitFor(() => client.closed !== null)
      expect(client.of('conversation.item.input_audio_transcription.failed')[0]).toMatchObject({
        error: { code: 'upstream_error', message: 'The gateway reported an error' }
      })
      const everything = JSON.stringify([client.events, logged, info.mock.calls, warn.mock.calls])
      expect(everything).not.toContain(key)
      expect(everything).not.toContain('invalid credentials')
    } finally {
      info.mockRestore()
      warn.mockRestore()
    }
  })

  it('tells the browser, and the live tab’s config, that the gateway does not allow the model', async () => {
    const { client, live, ended } = session('onprem', { model: 'mock-realtime-denied' })
    await live.start()
    expect(client.errorCodes).toEqual(['model_not_allowed'])
    expect(client.closed).toEqual({ code: CLOSE.error, reason: 'model_not_allowed' })
    await waitFor(ended)
    await expect(realtimeAvailability(target('onprem', 'mock-realtime-denied'))).resolves.toEqual({
      reason: 'modelNotAllowed',
      model: 'mock-realtime-denied'
    })
  })

  it('ends a session that sends what the server does not take, or more audio than real time', async () => {
    const first = session('onprem')
    await first.live.start()
    first.live.receive('{"type":"response.create"}')
    expect(first.client.errorCodes).toEqual(['invalid_event'])
    expect(first.client.closed?.code).toBe(CLOSE.policy)
    await waitFor(first.ended)

    const binary = session('onprem')
    await binary.live.start()
    binary.live.receive(Buffer.from('AAAA'), true)
    expect(binary.client.errorCodes).toEqual(['invalid_event'])

    const flood = session('onprem', { limits: { audioBurstMs: 2000 } })
    await flood.live.start()
    for (let index = 0; index < 25 && !flood.client.closed; index += 1) {
      flood.live.receive(append(100))
    }
    expect(flood.client.errorCodes).toEqual(['audio_rate_exceeded'])
    expect(flood.client.closed?.code).toBe(CLOSE.policy)
    await waitFor(flood.ended)
  })

  it('finalizes a session without audio, and one beyond its lifetime, with what it heard', async () => {
    const idle = session('onprem', { limits: { idleMs: 150 } })
    await idle.live.start()
    idle.live.receive(append(400))
    await waitFor(() => idle.client.closed !== null)
    expect(idle.client.errorCodes).toEqual(['session_idle'])
    expect(idle.client.of('conversation.item.input_audio_transcription.completed')).toHaveLength(1)
    expect(idle.client.closed?.code).toBe(CLOSE.normal)

    const expired = session('onprem', { limits: { maxSessionMs: 150 } })
    await expired.live.start()
    const feeding = setInterval(() => expired.live.receive(append(20)), 20)
    try {
      await waitFor(() => expired.client.closed !== null)
    } finally {
      clearInterval(feeding)
    }
    expect(expired.client.errorCodes).toEqual(['session_expired'])
    await waitFor(expired.ended)
  })

  it('rotates to a new item on keep_open, folding a flood of commits into one more', async () => {
    const { client, live } = session('onprem', { limits: { rotateMinIntervalMs: 300 } })
    await live.start()
    for (let index = 0; index < 5; index += 1) live.receive(append(100))
    for (let index = 0; index < 20; index += 1) live.receive(KEEP_OPEN)
    // Audio during the rotation is held and goes to the next item.
    for (let index = 0; index < 5; index += 1) live.receive(append(100))
    await waitFor(() => client.of('input_audio_buffer.committed').length >= 2)
    await new Promise((resolve) => setTimeout(resolve, 700))
    live.receive(COMMIT)
    await waitFor(() => client.closed !== null, 8000)
    const committed = client.of('input_audio_buffer.committed').map((event) => event.item_id)
    // The first item, the next, and the one more the flood folded into: never 21.
    expect(committed).toEqual([`item_${live.id}`, `item_${live.id}_1`, `item_${live.id}_2`])
    const completed = client.of('conversation.item.input_audio_transcription.completed')
    expect(completed.map((event) => event.item_id)).toEqual(committed)
    // Every event of an item comes after the last one's transcript.
    const order = client.events.map((event) => `${String(event.type)}:${String(event.item_id)}`)
    expect(order.indexOf(`input_audio_buffer.committed:item_${live.id}_1`)).toBeGreaterThan(
      order.indexOf(`conversation.item.input_audio_transcription.completed:item_${live.id}`)
    )
    expect(client.closed?.code).toBe(CLOSE.normal)
  })

  it('commits gpt-realtime-whisper’s audio itself while recording, and what is left on stop (W-1)', async () => {
    // The mock refuses voice detection for this model and makes items only of commits.
    const { client, live, ended } = session('openai')
    await live.start()
    expect(client.events[0]).toMatchObject({ session: { mode: 'openai', sample_rate: 24_000 } })
    // 3.5 s of silence: a quiet frame after each second ends a turn, so items come while recording.
    for (let index = 0; index < 35; index += 1) live.receive(append(100, 24_000))
    await waitFor(
      () => client.of('conversation.item.input_audio_transcription.completed').length === 3
    )
    expect(client.closed).toBeNull()
    // Half a second more, which only the stop's commit turns into an item.
    live.receive(append(500, 24_000))
    live.receive(COMMIT)
    await waitFor(() => client.closed !== null, 8000)
    const completed = client.of('conversation.item.input_audio_transcription.completed')
    expect(completed.map((event) => event.item_id)).toEqual([
      'item_mock_1',
      'item_mock_2',
      'item_mock_3',
      'item_mock_4'
    ])
    expect(client.closed?.code).toBe(CLOSE.normal)
    expect(client.errorCodes).toEqual([])
    await waitFor(ended)
  })

  it('keeps the gateway’s voice detection for models that have it, and drains on stop', async () => {
    const { client, live } = session('openai', { model: 'gpt-4o-transcribe' })
    await live.start()
    // The mock's voice detection ends an item every three seconds by itself.
    for (let index = 0; index < 35; index += 1) live.receive(append(100, 24_000))
    await waitFor(
      () => client.of('conversation.item.input_audio_transcription.completed').length === 1
    )
    live.receive(append(500, 24_000))
    live.receive(COMMIT)
    await waitFor(() => client.closed !== null, 8000)
    const completed = client.of('conversation.item.input_audio_transcription.completed')
    expect(completed.map((event) => event.item_id)).toEqual(['item_mock_1', 'item_mock_2'])
    expect(client.closed?.code).toBe(CLOSE.normal)
    expect(client.errorCodes).toEqual([])
  })

  it('stops an OpenAI session at once when nothing is left to commit', async () => {
    const { client, live } = session('openai')
    await live.start()
    live.receive(append(50, 24_000))
    live.receive(COMMIT)
    await waitFor(() => client.closed !== null, 1000)
    expect(client.errorCodes).toEqual([])
  })

  it('closes everything when the browser goes, and frees the slot', async () => {
    const { client, live, ended } = session('onprem')
    await live.start()
    live.receive(append(400))
    live.clientClosed(1001)
    expect(live.closed).toBe(true)
    // The slot is free once the gateway's stream has closed as well.
    expect(ended()).toBe(false)
    await waitFor(ended)
    // Nothing more reaches the browser, and messages are dropped.
    const sent = client.events.length
    live.receive(append(100))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(client.events).toHaveLength(sent)
  })

  it('ends a session whose browser does not read', async () => {
    const { client, live, ended } = session('onprem', { limits: { clientBufferMax: 10 } })
    client.bufferedAmount = 1000
    await live.start()
    expect(client.terminated).toBe(true)
    await waitFor(ended)
  })
})

describe('live sessions against a misbehaving gateway', () => {
  let server: WebSocketServer
  let port: number
  let behaviour: 'silent' | 'hangUp' = 'silent'

  beforeAll(async () => {
    server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise((resolve) => server.once('listening', resolve))
    port = (server.address() as AddressInfo).port
    server.on('connection', (socket) => {
      socket.on('message', (data) => {
        const event = JSON.parse(data.toString()) as { type: string }
        if (behaviour === 'hangUp' && event.type === 'input_audio_buffer.append') socket.close(1011)
      })
    })
  })
  afterAll(() => new Promise((resolve) => server.close(resolve)))

  function target(): RealtimeTarget {
    return {
      mode: 'onprem',
      apiBase: `http://127.0.0.1:${port}/v1`,
      url: `ws://127.0.0.1:${port}/v1/realtime?model=m`,
      apiKey: null,
      model: 'm'
    }
  }

  it('reports an item whose transcript never comes as failed, and still closes', async () => {
    behaviour = 'silent'
    const client = new FakeClient()
    const live = new LiveSession({
      target: target(),
      client,
      onEnd: () => {},
      limits: { ...FAST, doneTimeoutMs: 150 },
      log: () => {}
    })
    client.onClose = (code) => live.clientClosed(code)
    await live.start()
    live.receive(append(400))
    live.receive(COMMIT)
    await waitFor(() => client.closed !== null)
    expect(client.of('conversation.item.input_audio_transcription.failed')).toHaveLength(1)
    expect(client.closed?.code).toBe(CLOSE.normal)
  })

  it('ends a session whose gateway closes the stream while it runs', async () => {
    behaviour = 'hangUp'
    const client = new FakeClient()
    let ended = false
    const live = new LiveSession({
      target: target(),
      client,
      onEnd: () => {
        ended = true
      },
      limits: FAST,
      log: () => {}
    })
    client.onClose = (code) => live.clientClosed(code)
    await live.start()
    live.receive(append(100))
    await waitFor(() => client.closed !== null)
    expect(client.errorCodes).toEqual(['upstream_closed'])
    expect(client.closed?.code).toBe(CLOSE.error)
    await waitFor(() => ended)
  })
})

describe('the gateway handshake', () => {
  let mock: RunningMock

  beforeAll(async () => {
    mock = await startUpstreamMock()
  })
  afterAll(() => mock.close())
  beforeEach(() => forgetKeys())

  function target(model: string, apiKey: string | null = 'sk-test'): RealtimeTarget {
    return {
      mode: 'onprem',
      apiBase: `${mock.origin}/realtime/v1`,
      url: realtimeSocketUrl('onprem', `${mock.origin}/realtime/v1`, model),
      apiKey,
      model
    }
  }

  it('tells a model the key may not use from a refused key', async () => {
    const signal = new AbortController().signal
    const denied = target('mock-realtime-denied')
    const error = await openGateway(denied, signal).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(GatewayRefused)
    expect((error as GatewayRefused).status).toBe(403)
    await expect(unavailableReason(error, denied)).resolves.toBe('modelNotAllowed')
    await expect(probeGateway(denied)).resolves.toEqual({
      ok: false,
      reason: 'modelNotAllowed',
      status: 403
    })

    vi.stubEnv('TRANSCRIPTION_MOCK_REALTIME_KEY', 'the-right-key')
    try {
      await expect(probeGateway(target('voxtral-mini-realtime', 'a-wrong-key'))).resolves.toEqual({
        ok: false,
        reason: 'gatewayKeyRejected',
        status: 401
      })
      await expect(probeGateway(target('voxtral-mini-realtime', 'the-right-key'))).resolves.toEqual(
        { ok: true }
      )
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('finds a refusal right after the session update, and takes a working gateway', async () => {
    await expect(probeGateway(target('voxtral-mini-realtime'))).resolves.toEqual({ ok: true })
    await expect(probeGateway(target('mock-realtime-refused'))).resolves.toEqual({
      ok: false,
      reason: 'gatewayRefused',
      status: null
    })
  })

  it('gives up on a gateway that takes the connection and never answers the upgrade (C-2)', async () => {
    const held: Socket[] = []
    let dropped = 0
    const stalled = createNetServer((socket) => {
      held.push(socket)
      socket.resume()
      socket.on('close', () => (dropped += 1))
    })
    await new Promise<void>((resolve) => stalled.listen(0, '127.0.0.1', resolve))
    const { port } = stalled.address() as AddressInfo
    try {
      const started = Date.now()
      const error = await openGateway(
        { ...target('m'), url: `ws://127.0.0.1:${port}/v1/realtime?model=m` },
        new AbortController().signal,
        200
      ).catch((caught: unknown) => caught)
      expect(error).toBeInstanceOf(GatewayUnreachable)
      expect((error as GatewayUnreachable).timedOut).toBe(true)
      expect(Date.now() - started).toBeLessThan(2000)
      // The server drops the connection it gave up on.
      await waitFor(() => held.length === 1 && dropped === 1)
    } finally {
      for (const socket of held) socket.destroy()
      await new Promise((resolve) => stalled.close(resolve))
    }
    const unreachable = await openGateway(
      { ...target('m'), url: `ws://127.0.0.1:${port}/v1/realtime?model=m` },
      new AbortController().signal
    ).catch((caught: unknown) => caught)
    expect(unreachable).toBeInstanceOf(GatewayUnreachable)
    await expect(unavailableReason(unreachable, target('m'))).resolves.toBe('gatewayUnreachable')
  })

  it('reaches the gateway through the outbound proxy where fetch would, key in the header only', async () => {
    const tunnels: string[] = []
    const proxy: Server = createHttpServer()
    proxy.on('connect', (request, client: Socket, head) => {
      tunnels.push(request.url ?? '')
      const [host, port] = (request.url ?? '').split(':')
      const upstream = netConnect(Number(port), host, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        upstream.write(head)
        upstream.pipe(client)
        client.pipe(upstream)
      })
      upstream.on('error', () => client.destroy())
      client.on('error', () => upstream.destroy())
    })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`
    const environment = { HTTP_PROXY: proxyUrl, NODE_USE_ENV_PROXY: '1' }
    expect(proxyFor('ws://gateway.example/v1/realtime', environment)?.href).toBe(`${proxyUrl}/`)
    expect(proxyFor('wss://gateway.example/v1/realtime', environment)).toBeNull()
    expect(
      proxyFor('ws://gateway.example/v1', { ...environment, NO_PROXY: 'gateway.example' })
    ).toBeNull()
    expect(proxyFor('ws://gateway.example/v1', { HTTP_PROXY: proxyUrl })).toBeNull()
    for (const [name, value] of Object.entries(environment)) vi.stubEnv(name, value)
    vi.stubEnv('NO_PROXY', '')
    try {
      await expect(probeGateway(target('voxtral-mini-realtime'))).resolves.toEqual({ ok: true })
      expect(tunnels).toEqual([new URL(mock.origin).host])
    } finally {
      vi.unstubAllEnvs()
      proxy.closeAllConnections()
      await new Promise((resolve) => proxy.close(resolve))
    }
  })

  it('sets up a target per mode from the settings and what the admin typed', () => {
    const config = { ...TRANSCRIPTION_DEFAULT_CONFIG, asrBaseUrl: 'https://asr.example/v1' }
    expect(realtimeTarget('onprem', config, { ...NO_SECRETS, apiKey: 'k' })).toEqual({
      mode: 'onprem',
      apiBase: 'https://asr.example/v1',
      url: 'wss://asr.example/v1/realtime?model=voxtral-mini-realtime',
      apiKey: 'k',
      model: 'voxtral-mini-realtime'
    })
    expect(
      realtimeTarget('onprem', config, NO_SECRETS, {
        url: 'https://gw.example/v1',
        model: 'other',
        apiKey: null
      })
    ).toMatchObject({ url: 'wss://gw.example/v1/realtime?model=other', apiKey: null })
    expect(realtimeTarget('onprem', { ...config, asrBaseUrl: null }, NO_SECRETS)).toBeNull()
    expect(realtimeTarget('openai', config, NO_SECRETS)).toBeNull()
    expect(
      realtimeTarget('openai', config, { ...NO_SECRETS, openaiRealtimeApiKey: 'sk' })
    ).toMatchObject({ url: 'wss://api.openai.com/v1/realtime?intent=transcription' })
  })
})

describe('session slots', () => {
  it('holds as many sessions as allowed, in all and per person, and frees each once', () => {
    const slots = new SessionSlots(3, 2)
    const first = slots.reserve('alice')!
    const second = slots.reserve('alice')!
    expect(slots.reserve('alice')).toBeNull()
    const third = slots.reserve('bob')!
    expect(slots.reserve('carol')).toBeNull()
    first()
    first()
    expect(slots.active).toBe(2)
    expect(slots.reserve('alice')).not.toBeNull()
    second()
    third()
  })
})

describe('the live routes', () => {
  let mock: RunningMock
  let server: ReturnType<typeof serve>
  let base: string
  let config: Partial<TranscriptionComponentConfig>
  let signedOut = false

  beforeAll(async () => {
    mock = await startUpstreamMock()
    const app = new Hono<AppEnvironment>()
    app.use('*', async (context, next) => {
      if (!signedOut) {
        context.set('session', {
          user: { id: context.req.header('X-Test-User') ?? 'alice' }
        } as unknown as AppEnvironment['Variables']['session'])
      }
      context.set('module', {
        type: 'transcription',
        componentId: COMPONENT_ID,
        config: { ...TRANSCRIPTION_DEFAULT_CONFIG, ...config },
        secrets: { ...NO_SECRETS, apiKey: 'sk-route-key' }
      })
      await next()
    })
    app.route('/', realtimeRouter)
    server = await new Promise((resolve) => {
      const started = serve(
        {
          fetch: app.fetch,
          port: 0,
          hostname: '127.0.0.1',
          websocket: { server: createWebSocketServer() }
        },
        () => resolve(started)
      )
    })
    base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
    await mock.close()
  })
  beforeEach(() => {
    forgetAvailability()
    signedOut = false
    config = {
      realtimeModes: ['onprem'],
      onpremGatewayUrl: `${mock.origin}/realtime/v1`
    }
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  interface Opened {
    socket: WebSocket
    events: Record<string, unknown>[]
    closed: Promise<{ code: number; reason: string }>
  }

  function open(
    mode = 'onprem',
    headers: Record<string, string> = { Origin: 'http://localhost:5173' }
  ): Promise<Opened | { status: number }> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(
        `${base}${relative(TRANSCRIPTION_API.realtimeLive)}?mode=${mode}`,
        {
          headers
        }
      )
      const events: Record<string, unknown>[] = []
      socket.on('message', (data) =>
        events.push(JSON.parse(data.toString()) as Record<string, unknown>)
      )
      const closed = new Promise<{ code: number; reason: string }>((done) =>
        socket.once('close', (code, reason) => done({ code, reason: reason.toString() }))
      )
      socket.once('unexpected-response', (_request, response) => {
        resolve({ status: response.statusCode ?? 0 })
        socket.terminate()
      })
      socket.on('error', () => {})
      socket.once('open', () => resolve({ socket, events, closed }))
      setTimeout(() => reject(new Error('No answer')), 5000)
    })
  }

  async function opened(...args: Parameters<typeof open>): Promise<Opened> {
    const result = await open(...args)
    if (!('socket' in result)) throw new Error(`Refused with ${result.status}`)
    return result
  }

  it('refuses upgrades from other sites, without an origin or without a session', async () => {
    await expect(open('onprem', { Origin: 'https://evil.example' })).resolves.toEqual({
      status: 403
    })
    await expect(open('onprem', {})).resolves.toEqual({ status: 403 })
    await expect(open('nonsense')).resolves.toEqual({ status: 400 })
    signedOut = true
    await expect(open()).resolves.toEqual({ status: 401 })
  })

  it('relays a session from the browser through the server to the gateway', async () => {
    const live = await opened()
    await waitFor(() => live.events.length > 0)
    expect(live.events[0]).toMatchObject({ type: 'session.created' })
    for (let index = 0; index < 32; index += 1) live.socket.send(append(100))
    await waitFor(() =>
      live.events.some(
        (event) => event.type === 'conversation.item.input_audio_transcription.delta'
      )
    )
    live.socket.send(COMMIT)
    await expect(live.closed).resolves.toEqual({ code: CLOSE.normal, reason: 'done' })
    expect(
      live.events.find(
        (event) => event.type === 'conversation.item.input_audio_transcription.completed'
      )
    ).toMatchObject({ transcript: expect.stringMatching(/^Guten Morgen und willkommen/) })
    expect(JSON.stringify(live.events)).not.toContain('sk-route-key')
  })

  it('says in the socket why a mode cannot run: not set up, busy, model not allowed', async () => {
    const notSetUp = await opened('openai')
    await expect(notSetUp.closed).resolves.toMatchObject({ code: CLOSE.policy })
    expect(notSetUp.events).toEqual([
      { type: 'error', error: { code: 'not_set_up', message: 'This live mode is not set up' } }
    ])

    // Two sessions per person (TRANSCRIPTION_LIVE_MAX_SESSIONS_PER_USER).
    const first = await opened('onprem', { Origin: 'http://localhost:5173', 'X-Test-User': 'bob' })
    const second = await opened('onprem', { Origin: 'http://localhost:5173', 'X-Test-User': 'bob' })
    await waitFor(() => first.events.length > 0 && second.events.length > 0)
    const third = await opened('onprem', { Origin: 'http://localhost:5173', 'X-Test-User': 'bob' })
    await expect(third.closed).resolves.toMatchObject({ code: CLOSE.tryAgain, reason: 'busy' })
    first.socket.close()
    await first.closed
    await new Promise((resolve) => setTimeout(resolve, 50))
    const again = await opened('onprem', { Origin: 'http://localhost:5173', 'X-Test-User': 'bob' })
    await waitFor(() => again.events.length > 0)
    expect(again.events[0]).toMatchObject({ type: 'session.created' })
    second.socket.close()
    again.socket.close()

    config = { ...config, onpremRealtimeModel: 'mock-realtime-denied' }
    const denied = await opened()
    await expect(denied.closed).resolves.toMatchObject({ code: CLOSE.error })
    expect(denied.events.map((event) => (event.error as { code: string }).code)).toEqual([
      'model_not_allowed'
    ])
  })

  it('closes a socket that sends a message beyond the bound', async () => {
    const live = await opened()
    await waitFor(() => live.events.length > 0)
    live.socket.send('x'.repeat(TRANSCRIPTION_LIVE_MESSAGE_MAX_BYTES + 1))
    await expect(live.closed).resolves.toMatchObject({ code: 1009 })
  })

  it('offers on-prem in the config only while the gateway takes the model', async () => {
    const app = testApp(realtimeRouter, {
      config: {
        realtimeModes: ['onprem', 'openai'],
        onpremGatewayUrl: `${mock.origin}/realtime/v1`
      },
      secrets: { apiKey: 'sk-route-key' }
    })
    const response = await app.request(`http://test${relative(TRANSCRIPTION_API.realtimeConfig)}`)
    await expect(response.json()).resolves.toEqual({
      modes: ['onprem'],
      defaultMode: 'onprem',
      onpremUnavailable: null
    })
    const denied = testApp(realtimeRouter, {
      config: {
        realtimeModes: ['onprem'],
        onpremGatewayUrl: `${mock.origin}/realtime/v1`,
        onpremRealtimeModel: 'mock-realtime-denied'
      }
    })
    const refused = await denied.request(`http://test${relative(TRANSCRIPTION_API.realtimeConfig)}`)
    await expect(refused.json()).resolves.toEqual({
      modes: [],
      defaultMode: null,
      onpremUnavailable: { reason: 'modelNotAllowed', model: 'mock-realtime-denied' }
    })
  })
})

/**
 * A gateway stream the test drives by hand, in place of `openGateway`'s socket: what the relay
 * sent, and events delivered when the test says. `stuck` leaves it closing on `close()` until it
 * is terminated.
 */
class FakeUpstream extends EventEmitter {
  readyState: number = WebSocket.OPEN
  bufferedAmount = 0
  readonly sent: Record<string, unknown>[] = []
  stuck = false
  /** A gateway that does not read: everything sent stays queued. */
  slow = false
  terminated = false

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
    if (this.slow) this.bufferedAmount += data.length
  }

  close(code = 1000): void {
    if (this.readyState !== WebSocket.OPEN) return
    this.readyState = WebSocket.CLOSING
    if (!this.stuck) setImmediate(() => this.finish(code))
  }

  terminate(): void {
    this.terminated = true
    setImmediate(() => this.finish(1006))
  }

  /** The gateway closes the stream. */
  finish(code: number): void {
    if (this.readyState === WebSocket.CLOSED) return
    this.readyState = WebSocket.CLOSED
    this.emit('close', code)
  }

  deliver(event: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(event)), false)
  }

  of(type: string): Record<string, unknown>[] {
    return this.sent.filter((event) => event.type === type)
  }
}

/** Frames of `ms` at `rate` that are loud throughout (a square wave), so no turn ends quietly. */
function loud(ms: number, rate = 24_000): string {
  const pcm = Buffer.alloc(((rate * 2) / 1000) * ms)
  for (let offset = 0; offset < pcm.length; offset += 2) {
    pcm.writeInt16LE(offset % 96 < 48 ? 8000 : -8000, offset)
  }
  return JSON.stringify({ type: 'input_audio_buffer.append', audio: pcm.toString('base64') })
}

/** A private field of the session, for what the review checked from the inside. */
function inside<T>(live: LiveSession, field: string): T {
  return (live as unknown as Record<string, T>)[field]!
}

describe('live sessions against a scripted gateway (review W-1 … W-8)', () => {
  let logged: string[]

  beforeEach(() => {
    logged = []
  })

  interface Scripted {
    client: FakeClient
    live: LiveSession
    streams: FakeUpstream[]
    ended: () => boolean
  }

  function scripted(
    mode: 'onprem' | 'openai',
    options: {
      model?: string
      limits?: Partial<LiveLimits>
      /** Resolves the open, else at once. */
      gate?: Promise<void>
      stuck?: boolean
      slow?: boolean
      onEnd?: () => void
    } = {}
  ): Scripted {
    const client = new FakeClient()
    const streams: FakeUpstream[] = []
    let ended = 0
    const model = options.model ?? (mode === 'onprem' ? 'm' : 'gpt-realtime-whisper')
    const live = new LiveSession({
      target: {
        mode,
        apiBase: 'http://gateway.invalid/v1',
        url: 'ws://gateway.invalid/v1/realtime',
        apiKey: null,
        model
      },
      client,
      onEnd: () => {
        ended += 1
        options.onEnd?.()
      },
      limits: { ...FAST, ...options.limits },
      log: (event, fields) => logged.push(`${event} ${JSON.stringify(fields ?? {})}`),
      open: async () => {
        await options.gate
        const stream = new FakeUpstream()
        stream.stuck = options.stuck ?? false
        stream.slow = options.slow ?? false
        streams.push(stream)
        return stream as unknown as WebSocket
      }
    })
    client.onClose = (code) => live.clientClosed(code)
    return { client, live, streams, ended: () => ended === 1 }
  }

  const committed = (itemId: string): unknown => ({
    type: 'input_audio_buffer.committed',
    item_id: itemId
  })
  const completed = (itemId: string, transcript = 'Hallo'): unknown => ({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: itemId,
    transcript
  })
  const empty = (eventId: unknown): unknown => ({
    type: 'error',
    error: { code: 'input_audio_buffer_commit_empty', event_id: eventId }
  })

  it('W-1: commits gpt-realtime-whisper’s audio at a quiet frame or after the longest turn', async () => {
    const { live, streams } = scripted('openai')
    await live.start()
    const [stream] = streams
    // Loud audio: no commit before three seconds, one at three.
    for (let index = 0; index < 29; index += 1) live.receive(loud(100))
    expect(stream!.of('input_audio_buffer.commit')).toHaveLength(0)
    live.receive(loud(100))
    expect(stream!.of('input_audio_buffer.commit')).toEqual([
      { type: 'input_audio_buffer.commit', event_id: 'turn_1' }
    ])
    // A quiet frame after a second ends the next turn early, not before.
    for (let index = 0; index < 9; index += 1) live.receive(loud(100))
    live.receive(append(50, 24_000))
    expect(stream!.of('input_audio_buffer.commit')).toHaveLength(1)
    live.receive(append(100, 24_000))
    expect(stream!.of('input_audio_buffer.commit')).toHaveLength(2)
    // Commits are counted until answered.
    expect(inside<number>(live, 'commitsInFlight')).toBe(2)
    stream!.deliver(committed('item_a'))
    stream!.deliver(empty('turn_2'))
    expect(inside<number>(live, 'commitsInFlight')).toBe(0)
    live.close()
  })

  it('W-2: stop waits for the answer to its own commit, not a delayed commit of voice detection', async () => {
    const { client, live, streams } = scripted('openai', {
      model: 'gpt-4o-transcribe',
      limits: { doneTimeoutMs: 2000 }
    })
    await live.start()
    const [stream] = streams
    live.receive(append(100, 24_000))
    live.receive(append(100, 24_000))
    live.receive(append(100, 24_000))
    expect(stream!.of('input_audio_buffer.append')).toHaveLength(3)
    // Voice detection's commit of an earlier turn arrives late, after the last audio was sent.
    stream!.deliver(committed('item_vad'))
    stream!.deliver(completed('item_vad'))
    live.receive(COMMIT)
    await waitFor(() => stream!.of('input_audio_buffer.commit').length === 1)
    expect(stream!.of('input_audio_buffer.commit')[0]).toEqual({
      type: 'input_audio_buffer.commit',
      event_id: 'final_1'
    })
    // Not satisfied by the earlier commit: still open.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(client.closed).toBeNull()
    // The last audio becomes an item; whose commit that was, the server asks once more.
    stream!.deliver(committed('item_last'))
    await waitFor(() => stream!.of('input_audio_buffer.commit').length === 2)
    stream!.deliver(empty('final_2'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    // The buffer is empty now; the transcript of the last item is still awaited.
    expect(client.closed).toBeNull()
    stream!.deliver(completed('item_last', 'Ende'))
    await waitFor(() => client.closed !== null)
    expect(client.closed?.code).toBe(CLOSE.normal)
    expect(
      client.of('conversation.item.input_audio_transcription.completed').map((e) => e.item_id)
    ).toEqual(['item_vad', 'item_last'])
    expect(client.of('conversation.item.input_audio_transcription.failed')).toEqual([])
  })

  it('W-2: without voice detection, stop waits until each of its commits is answered', async () => {
    const { client, live, streams } = scripted('openai', { limits: { doneTimeoutMs: 2000 } })
    await live.start()
    const [stream] = streams
    for (let index = 0; index < 10; index += 1) live.receive(append(100, 24_000))
    live.receive(append(300, 24_000))
    // One turn commit while recording, one final commit on stop.
    live.receive(COMMIT)
    await waitFor(() => stream!.of('input_audio_buffer.commit').length === 2)
    stream!.deliver(committed('item_1'))
    stream!.deliver(completed('item_1'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(client.closed).toBeNull()
    stream!.deliver(committed('item_2'))
    stream!.deliver(completed('item_2'))
    await waitFor(() => client.closed !== null)
    expect(client.closed?.code).toBe(CLOSE.normal)
  })

  it('W-3: a start that ends on backpressure leaves no watchdog behind', async () => {
    let opened!: () => void
    const gate = new Promise<void>((resolve) => {
      opened = resolve
    })
    const { client, live, ended } = scripted('onprem', {
      gate,
      slow: true,
      limits: { watchIntervalMs: 10, upstreamBufferMax: 1000, messageBurst: 10_000 }
    })
    const starting = live.start()
    // Frames that came while the gateway opened; flushing them meets the full queue.
    for (let index = 0; index < 1000; index += 1) live.receive(append(2))
    opened()
    await starting
    expect(live.closed).toBe(true)
    expect(client.errorCodes).toEqual(['upstream_error'])
    expect(inside<Set<NodeJS.Timeout>>(live, 'timers').size).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(inside<Set<NodeJS.Timeout>>(live, 'timers').size).toBe(0)
    expect(logged.some((line) => line.startsWith('finalizing on its own'))).toBe(false)
    await waitFor(ended)
  })

  it('W-3: closing before the gateway answers takes no timer either', async () => {
    let opened!: () => void
    const gate = new Promise<void>((resolve) => {
      opened = resolve
    })
    const { live, ended } = scripted('openai', { gate })
    const starting = live.start()
    live.close()
    opened()
    await starting
    expect(inside<Set<NodeJS.Timeout>>(live, 'timers').size).toBe(0)
    await waitFor(ended)
  })

  it('W-4: a slot stays taken until the session’s sockets are gone', async () => {
    const slots = new SessionSlots(1, 1)
    for (let cycle = 0; cycle < 5; cycle += 1) {
      const release = slots.reserve('alice')
      expect(release).not.toBeNull()
      const { live, streams } = scripted('onprem', {
        stuck: true,
        onEnd: release!,
        limits: { closeMs: 40 }
      })
      await live.start()
      live.close()
      // The gateway's socket still closes: no replacement yet.
      expect(streams[0]!.readyState).toBe(WebSocket.CLOSING)
      expect(slots.reserve('alice')).toBeNull()
      expect(slots.active).toBe(1)
      // Dropped after closeMs, then the slot is free.
      await waitFor(() => slots.active === 0, 1000)
      expect(streams[0]!.terminated).toBe(true)
    }
  })

  it('W-4: a session whose sockets never report their close frees its slot at last', async () => {
    const slots = new SessionSlots(1, 1)
    const release = slots.reserve('alice')!
    const { client, live } = scripted('onprem', { onEnd: release, limits: { closeMs: 30 } })
    client.stuck = true
    client.onClose = null
    await live.start()
    live.close()
    expect(slots.active).toBe(1)
    await waitFor(() => slots.active === 0, 1000)
    expect(client.terminated).toBe(true)
    expect(logged.some((line) => line.startsWith('sockets did not close'))).toBe(true)
  })

  it('W-4: rotations keep one closing stream at most', async () => {
    const { client, live, streams } = scripted('onprem', {
      stuck: true,
      limits: { rotateMinIntervalMs: 10 }
    })
    await live.start()
    let most = 0
    for (let round = 0; round < 5; round += 1) {
      live.receive(append(400))
      live.receive(KEEP_OPEN)
      const stream = streams.at(-1)!
      await waitFor(() => stream.of('input_audio_buffer.commit').length === 2)
      stream.emit(
        'message',
        Buffer.from(JSON.stringify({ type: 'transcription.done', text: 'x' })),
        false
      )
      await waitFor(
        () => streams.length === round + 2 && inside<Item | null>(live, 'item') !== null
      )
      most = Math.max(most, inside<Set<unknown>>(live, 'upstreams').size)
      const closing = streams.filter((s) => s.readyState === WebSocket.CLOSING)
      expect(closing.length).toBeLessThanOrEqual(1)
    }
    expect(most).toBeLessThanOrEqual(3)
    expect(client.closed).toBeNull()
    live.close()
  })

  it('W-5: messages count before they are parsed, ignored ones and tiny appends too', async () => {
    const ignored = scripted('onprem')
    await ignored.live.start()
    const update = JSON.stringify({ type: 'session.update', padding: 'x'.repeat(95 * 1024) })
    let accepted = 0
    for (let index = 0; index < 10_000 && !ignored.live.closed; index += 1) {
      ignored.live.receive(update)
      if (!ignored.live.closed) accepted += 1
    }
    expect(ignored.client.errorCodes).toEqual(['message_rate_exceeded'])
    expect(ignored.client.closed?.code).toBe(CLOSE.policy)
    expect(accepted).toBeLessThan(10)

    const tiny = scripted('onprem')
    await tiny.live.start()
    const sample = JSON.stringify({ type: 'input_audio_buffer.append', audio: 'AAA=' })
    let appended = 0
    for (let index = 0; index < 70_000 && !tiny.live.closed; index += 1) {
      tiny.live.receive(sample)
      if (!tiny.live.closed) appended += 1
    }
    expect(tiny.client.errorCodes).toEqual(['message_rate_exceeded'])
    // The burst, and what the rate refills while the loop runs.
    expect(appended).toBeLessThanOrEqual(DEFAULT_LIVE_LIMITS.messageBurst + 10)
    expect(tiny.streams[0]!.of('input_audio_buffer.append').length).toBe(appended)
  })

  it('W-5: audio held while the gateway opens is coalesced, one buffer a second', async () => {
    let opened!: () => void
    const gate = new Promise<void>((resolve) => {
      opened = resolve
    })
    const { live, streams } = scripted('onprem', { gate })
    const starting = live.start()
    // Ten seconds of 100 ms frames, a normal burst.
    for (let index = 0; index < 100; index += 1) live.receive(append(100))
    expect(live.closed).toBe(false)
    expect(inside<unknown[]>(live, 'hold')).toHaveLength(10)
    opened()
    await starting
    const appends = streams[0]!.of('input_audio_buffer.append')
    expect(appends).toHaveLength(10)
    expect(
      appends.reduce((sum, event) => sum + Buffer.from(String(event.audio), 'base64').length, 0)
    ).toBe(100 * 3200)
    live.close()
  })

  it('W-6: a gateway that leaves items open ends the session, bounded', async () => {
    const { client, live, streams } = scripted('openai')
    await live.start()
    const [stream] = streams
    for (let index = 0; index < 10_000 && !live.closed; index += 1) {
      stream!.deliver(committed(`item_${index}`))
    }
    expect(live.closed).toBe(true)
    expect(client.errorCodes).toEqual(['upstream_error'])
    const announced = client.of('input_audio_buffer.committed')
    expect(announced.length).toBeLessThanOrEqual(DEFAULT_LIVE_LIMITS.pendingMax)
    // Every item the browser waits for is resolved for it.
    expect(client.of('conversation.item.input_audio_transcription.failed')).toHaveLength(
      announced.length
    )
    expect(inside<Map<string, number>>(live, 'pending').size).toBe(0)
  })

  it('W-6: an item without its transcript in time fails, and the session goes on', async () => {
    const { client, live, streams } = scripted('openai', { limits: { itemTimeoutMs: 60 } })
    await live.start()
    streams[0]!.deliver(committed('item_slow'))
    await waitFor(() => client.of('conversation.item.input_audio_transcription.failed').length > 0)
    expect(client.of('conversation.item.input_audio_transcription.failed')[0]).toMatchObject({
      item_id: 'item_slow'
    })
    expect(live.closed).toBe(false)
    live.close()
  })

  it('W-6: a gateway flooding events ends the session', async () => {
    const { client, live, streams } = scripted('openai', {
      limits: { upstreamMessageBurst: 100, upstreamMessageRate: 1 }
    })
    await live.start()
    const delta = {
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'item_1',
      delta: 'x'
    }
    let delivered = 0
    for (let index = 0; index < 10_000 && !live.closed; index += 1) {
      streams[0]!.deliver(delta)
      delivered += 1
    }
    expect(live.closed).toBe(true)
    expect(client.errorCodes).toEqual(['upstream_error'])
    expect(delivered).toBeLessThanOrEqual(102)
  })

  it('W-8: an item whose stream closes before its transcript is reported as failed', async () => {
    const { client, live, streams } = scripted('onprem')
    await live.start()
    live.receive(append(400))
    live.receive(COMMIT)
    const [stream] = streams
    await waitFor(() => stream!.of('input_audio_buffer.commit').length === 2)
    stream!.finish(1011)
    await waitFor(() => client.closed !== null)
    expect(client.of('conversation.item.input_audio_transcription.failed')).toEqual([
      expect.objectContaining({ item_id: `item_${live.id}` })
    ])
    expect(client.of('conversation.item.input_audio_transcription.completed')).toEqual([])
  })

  it('W-8: a transcript followed by a normal close does not fail as well', async () => {
    const { client, live, streams } = scripted('onprem')
    await live.start()
    live.receive(append(400))
    live.receive(COMMIT)
    const [stream] = streams
    await waitFor(() => stream!.of('input_audio_buffer.commit').length === 2)
    stream!.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'transcription.done', text: 'Hallo' })),
      false
    )
    stream!.finish(1000)
    await waitFor(() => client.closed !== null)
    expect(client.closed?.code).toBe(CLOSE.normal)
    expect(client.of('conversation.item.input_audio_transcription.completed')).toHaveLength(1)
    expect(client.of('conversation.item.input_audio_transcription.failed')).toEqual([])
  })

  it('W-8: a rotation whose old stream closes without a transcript fails that item and goes on', async () => {
    const { client, live, streams } = scripted('onprem', { limits: { rotateMinIntervalMs: 10 } })
    await live.start()
    live.receive(append(400))
    live.receive(KEEP_OPEN)
    const [old] = streams
    await waitFor(() => old!.of('input_audio_buffer.commit').length === 2)
    old!.finish(1011)
    await waitFor(() => inside<Item | null>(live, 'item') !== null && streams.length === 2)
    expect(client.of('conversation.item.input_audio_transcription.failed')).toEqual([
      expect.objectContaining({ item_id: `item_${live.id}` })
    ])
    expect(live.closed).toBe(false)
    live.receive(append(100))
    expect(streams[1]!.of('input_audio_buffer.append')).toHaveLength(1)
    live.close()
  })
})

/** The relay's item, as far as the tests look into it. */
type Item = { id: string }
