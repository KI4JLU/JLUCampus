import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CONNECTION_TIMEOUT_MS,
  DRAIN_TIMEOUT_MS,
  RealtimeError,
  RealtimeSession,
  type RealtimeDependencies,
  type RealtimeHandlers
} from './session'

class FakeChannel extends EventTarget {
  readyState: RTCDataChannelState = 'connecting'
  sent: unknown[] = []
  closed = false
  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }
  close(): void {
    this.closed = true
    this.readyState = 'closed'
    this.dispatchEvent(new Event('close'))
  }
  open(): void {
    this.readyState = 'open'
    this.dispatchEvent(new Event('open'))
  }
  receive(event: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event) }))
  }
}

class FakePeer extends EventTarget {
  iceGatheringState: RTCIceGatheringState = 'complete'
  connectionState: RTCPeerConnectionState = 'new'
  localDescription: { sdp: string } | null = null
  remoteDescription: RTCSessionDescriptionInit | null = null
  channel = new FakeChannel()
  tracks: MediaStreamTrack[] = []
  closed = false
  constructor(readonly configuration: RTCConfiguration) {
    super()
  }
  createDataChannel(label: string): FakeChannel {
    expect(label).toBe('oai-events')
    return this.channel
  }
  addTrack(track: MediaStreamTrack): void {
    this.tracks.push(track)
  }
  createOffer(): Promise<RTCSessionDescriptionInit> {
    return Promise.resolve({ type: 'offer', sdp: 'offer' })
  }
  setLocalDescription(): Promise<void> {
    this.localDescription = { sdp: 'offer+candidates' }
    return Promise.resolve()
  }
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = description
    return Promise.resolve()
  }
  connect(state: RTCPeerConnectionState = 'connected'): void {
    this.connectionState = state
    this.dispatchEvent(new Event('connectionstatechange'))
  }
  close(): void {
    this.closed = true
  }
}

function fakeStream(): { stream: MediaStream; stopped: () => boolean } {
  const track = { stop: vi.fn() } as unknown as MediaStreamTrack
  return {
    stream: { getTracks: () => [track] } as unknown as MediaStream,
    stopped: () => (track.stop as ReturnType<typeof vi.fn>).mock.calls.length > 0
  }
}

function setup(overrides: Partial<RealtimeDependencies> = {}): {
  session: RealtimeSession
  peers: FakePeer[]
  handlers: RealtimeHandlers & { text: string }
  dependencies: RealtimeDependencies
} {
  const peers: FakePeer[] = []
  const handlers = {
    text: '',
    onText: vi.fn((text: string) => {
      handlers.text += text
    }),
    onServiceError: vi.fn(),
    onConnectionLost: vi.fn()
  }
  const dependencies: RealtimeDependencies = {
    createPeer: (configuration) => {
      const peer = new FakePeer(configuration)
      peers.push(peer)
      return peer as unknown as RTCPeerConnection
    },
    onpremSignaling: vi.fn(() => Promise.resolve('answer')),
    openaiSession: vi.fn(() =>
      Promise.resolve({
        value: 'ek_1',
        callsUrl: 'https://api.openai.com/v1/realtime/calls',
        model: 'gpt-realtime-whisper'
      })
    ),
    fetch: vi.fn(() => Promise.resolve(new Response('openai-answer'))) as typeof fetch,
    ...overrides
  }
  return { session: new RealtimeSession(handlers, dependencies), peers, handlers, dependencies }
}

/** Starts an on-prem session and lets the fake peer connect. */
async function started(context: ReturnType<typeof setup>, stream: MediaStream): Promise<FakePeer> {
  const starting = context.session.start({
    stream,
    mode: 'onprem',
    iceServers: [{ urls: ['turn:turn.example:3478'] }],
    openaiModel: null
  })
  await vi.waitFor(() => expect(context.peers[0]?.remoteDescription).not.toBeNull())
  const peer = context.peers[0]!
  peer.connect()
  await starting
  peer.channel.open()
  return peer
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('RealtimeSession', () => {
  it('connects on-prem with the ICE servers, the gathered offer and the bridge answer', async () => {
    const context = setup()
    const { stream } = fakeStream()
    const peer = await started(context, stream)
    expect(peer.configuration).toEqual({ iceServers: [{ urls: ['turn:turn.example:3478'] }] })
    expect(context.dependencies.onpremSignaling).toHaveBeenCalledWith('offer+candidates')
    expect(peer.remoteDescription).toEqual({ type: 'answer', sdp: 'answer' })
    expect(peer.tracks).toHaveLength(1)
    expect(context.session.isRecording).toBe(true)
    // The bridge manages its session itself.
    expect(peer.channel.sent).toEqual([])
  })

  it('shows a delta followed by the identical completion once', async () => {
    const context = setup()
    const peer = await started(context, fakeStream().stream)
    peer.channel.receive({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'a',
      delta: 'Hallo'
    })
    peer.channel.receive({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'a',
      transcript: 'Hallo'
    })
    expect(context.handlers.text).toBe('Hallo ')
  })

  it('commits on stop, waits for the pending transcript, then closes everything', async () => {
    const context = setup()
    const { stream, stopped } = fakeStream()
    const peer = await started(context, stream)
    peer.channel.receive({ type: 'input_audio_buffer.committed', item_id: 'a' })
    const stopping = context.session.stop()
    expect(context.session.stop()).toBe(stopping)
    expect(peer.channel.sent).toEqual([{ type: 'input_audio_buffer.commit' }])
    expect(peer.closed).toBe(false)
    peer.channel.receive({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'a',
      transcript: 'Ende.'
    })
    await stopping
    expect(context.handlers.text).toBe('Ende. ')
    expect(peer.closed).toBe(true)
    expect(peer.channel.closed).toBe(true)
    expect(stopped()).toBe(true)
    expect(context.handlers.onConnectionLost).not.toHaveBeenCalled()
  })

  it('closes after the drain timeout when no transcript comes', async () => {
    const context = setup()
    const peer = await started(context, fakeStream().stream)
    let done = false
    const stopping = context.session.stop().then(() => {
      done = true
    })
    await vi.advanceTimersByTimeAsync(DRAIN_TIMEOUT_MS - 100)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(200)
    await stopping
    expect(peer.closed).toBe(true)
  })

  it('fails when the audio connection is not up within 15 s and releases the microphone', async () => {
    const context = setup()
    const { stream, stopped } = fakeStream()
    const starting = context.session.start({
      stream,
      mode: 'onprem',
      iceServers: [],
      openaiModel: null
    })
    const failure = expect(starting).rejects.toMatchObject({ code: 'connectionTimeout' })
    await vi.advanceTimersByTimeAsync(CONNECTION_TIMEOUT_MS + 10)
    await failure
    expect(context.peers[0]?.configuration).toEqual({})
    expect(context.peers[0]?.closed).toBe(true)
    expect(stopped()).toBe(true)
  })

  it('reports the bridge error with the server message', async () => {
    const context = setup({
      onpremSignaling: () =>
        Promise.reject(
          Object.assign(new Error('x'), {
            body: { error: { code: 'module_unavailable', message: 'Bridge down' } }
          })
        )
    })
    const error = await context.session
      .start({ stream: fakeStream().stream, mode: 'onprem', iceServers: [], openaiModel: null })
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(RealtimeError)
    expect(error).toMatchObject({ code: 'bridgeError', detail: 'Bridge down' })
  })

  it('offers OpenAI the SDP with the ephemeral key and configures the transcription model', async () => {
    const context = setup()
    const starting = context.session.start({
      stream: fakeStream().stream,
      mode: 'openai',
      iceServers: [{ urls: ['turn:ignored'] }],
      openaiModel: 'from-config'
    })
    await vi.waitFor(() => expect(context.peers[0]?.remoteDescription).not.toBeNull())
    const peer = context.peers[0]!
    expect(peer.configuration).toEqual({})
    expect(context.dependencies.fetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/realtime/calls',
      expect.objectContaining({
        method: 'POST',
        body: 'offer+candidates',
        headers: { Authorization: 'Bearer ek_1', 'Content-Type': 'application/sdp' }
      })
    )
    expect(peer.remoteDescription).toEqual({ type: 'answer', sdp: 'openai-answer' })
    peer.connect()
    await starting
    peer.channel.open()
    expect(peer.channel.sent).toEqual([
      {
        type: 'session.update',
        session: {
          type: 'transcription',
          audio: { input: { transcription: { model: 'gpt-realtime-whisper' } } }
        }
      }
    ])
    // OpenAI commits turns itself: stopping does not wait.
    await context.session.stop()
    expect(peer.closed).toBe(true)
  })

  it('prefixes errors of the OpenAI endpoint', async () => {
    const context = setup({
      fetch: (() => Promise.resolve(new Response('bad key', { status: 401 }))) as typeof fetch
    })
    await expect(
      context.session.start({
        stream: fakeStream().stream,
        mode: 'openai',
        iceServers: [],
        openaiModel: null
      })
    ).rejects.toMatchObject({ code: 'openaiError', detail: 'bad key' })
  })

  it('reports a dropped connection while recording and tears down', async () => {
    const context = setup()
    const { stream, stopped } = fakeStream()
    const peer = await started(context, stream)
    peer.connect('failed')
    expect(context.handlers.onConnectionLost).toHaveBeenCalledWith('connectionFailed')
    expect(stopped()).toBe(true)
    expect(context.session.isRecording).toBe(false)
  })
})
