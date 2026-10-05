import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CONNECTION_TIMEOUT_MS,
  DRAIN_TIMEOUT_MS,
  MAX_BUFFERED_BYTES,
  RealtimeError,
  RealtimeSession,
  type AudioCapture,
  type RealtimeDependencies,
  type RealtimeHandlers
} from './session'

/** The server's live socket, as the session sees it. */
class FakeSocket extends EventTarget {
  readyState: number = WebSocket.CONNECTING
  bufferedAmount = 0
  sent: Record<string, unknown>[] = []
  closedWith: number | null = null
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }
  close(code = 1000): void {
    this.closedWith ??= code
    this.finish()
  }
  open(): void {
    this.readyState = WebSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }
  receive(event: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event) }))
  }
  /** The server closes the socket. */
  finish(): void {
    if (this.readyState === WebSocket.CLOSED) return
    this.readyState = WebSocket.CLOSED
    this.dispatchEvent(new Event('close'))
  }
}

class FakeCapture implements AudioCapture {
  stopped = false
  closed = false
  constructor(
    readonly sampleRate: number,
    readonly onFrame: (pcm: Uint8Array) => void
  ) {}
  stop(): Promise<void> {
    this.stopped = true
    // The worklet's last partial frame.
    this.onFrame(new Uint8Array([1, 0, 2, 0]))
    return Promise.resolve()
  }
  close(): void {
    this.closed = true
  }
}

interface Setup {
  socket: FakeSocket
  tracks: { stop: ReturnType<typeof vi.fn> }[]
  stream: MediaStream
  handlers: { [K in keyof RealtimeHandlers]: ReturnType<typeof vi.fn> }
  session: RealtimeSession
  modes: string[]
  capture: () => FakeCapture | null
}

function setup(options: { captureFails?: boolean; captureGate?: Promise<void> } = {}): Setup {
  const socket = new FakeSocket()
  const tracks = [{ stop: vi.fn() }]
  const stream = { getTracks: () => tracks } as unknown as MediaStream
  let capture: FakeCapture | null = null
  const modes: string[] = []
  const dependencies: RealtimeDependencies = {
    openSocket: (mode) => {
      modes.push(mode)
      return socket as unknown as WebSocket
    },
    capture: async (_stream, sampleRate, onFrame) => {
      await options.captureGate
      if (options.captureFails) throw new Error('NotSupportedError')
      capture = new FakeCapture(sampleRate, onFrame)
      return capture
    }
  }
  const handlers = {
    onText: vi.fn(),
    onServiceError: vi.fn(),
    onConnectionLost: vi.fn()
  } satisfies RealtimeHandlers
  const session = new RealtimeSession(handlers, dependencies)
  return {
    socket,
    tracks,
    stream,
    handlers,
    session,
    modes,
    capture: () => capture
  }
}

/** Lets the session's awaits run. */
async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
}

describe('live sessions over the server’s WebSocket', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('starts the audio once the server took the session, at the mode’s rate', async () => {
    const { socket, session, stream, modes, capture } = setup()
    const started = session.start({ stream, mode: 'onprem' })
    socket.open()
    await settle()
    expect(capture()).toBeNull()
    socket.receive({ type: 'session.created', session: { mode: 'onprem', sample_rate: 16_000 } })
    await started
    expect(modes).toEqual(['onprem'])
    expect(capture()?.sampleRate).toBe(16_000)
    expect(session.isRecording).toBe(true)
    // Frames go as base64 PCM16 appends.
    capture()!.onFrame(new Uint8Array([0, 1, 2, 3]))
    expect(socket.sent).toEqual([{ type: 'input_audio_buffer.append', audio: 'AAECAw==' }])
  })

  it('takes OpenAI’s rate for the OpenAI mode', async () => {
    const { socket, session, stream, capture } = setup()
    const started = session.start({ stream, mode: 'openai' })
    socket.open()
    socket.receive({ type: 'session.created' })
    await started
    expect(capture()?.sampleRate).toBe(24_000)
  })

  it('fails with the server’s code when it refuses the session, and frees the microphone', async () => {
    const { socket, session, stream, tracks } = setup()
    const started = session.start({ stream, mode: 'onprem' })
    socket.open()
    socket.receive({ type: 'error', error: { code: 'model_not_allowed', message: 'words' } })
    const error = await started.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(RealtimeError)
    expect(error).toMatchObject({ code: 'refused', detail: 'model_not_allowed' })
    expect(tracks[0]!.stop).toHaveBeenCalled()
    expect(socket.closedWith).toBe(1000)
  })

  it('fails when the upgrade is refused, the socket closes early or nothing comes in time', async () => {
    const refused = setup()
    const first = refused.session.start({ stream: refused.stream, mode: 'onprem' })
    refused.socket.finish()
    await expect(first).rejects.toMatchObject({ code: 'connectionFailed' })

    const closed = setup()
    const second = closed.session.start({ stream: closed.stream, mode: 'onprem' })
    closed.socket.open()
    closed.socket.finish()
    await expect(second).rejects.toMatchObject({ code: 'connectionClosed' })

    const silent = setup()
    const third = silent.session.start({ stream: silent.stream, mode: 'onprem' })
    silent.socket.open()
    vi.advanceTimersByTime(CONNECTION_TIMEOUT_MS)
    await expect(third).rejects.toMatchObject({ code: 'connectionTimeout' })
    expect(silent.socket.closedWith).toBe(1000)
  })

  it('fails when the audio processing cannot start', async () => {
    const { socket, session, stream, tracks } = setup({ captureFails: true })
    const started = session.start({ stream, mode: 'onprem' })
    socket.open()
    socket.receive({ type: 'session.created' })
    await expect(started).rejects.toMatchObject({ code: 'audioFailed' })
    expect(tracks[0]!.stop).toHaveBeenCalled()
    expect(socket.closedWith).toBe(1000)
  })

  it('appends transcripts and passes service errors on while it runs', async () => {
    const { socket, session, stream, handlers } = setup()
    const started = session.start({ stream, mode: 'onprem' })
    socket.open()
    socket.receive({ type: 'session.created' })
    await started
    socket.receive({ type: 'input_audio_buffer.committed', item_id: 'a' })
    socket.receive({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: 'a',
      delta: 'Hallo'
    })
    socket.receive({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'a',
      transcript: 'Hallo Welt'
    })
    expect(handlers.onText.mock.calls.map(([text]) => text)).toEqual(['Hallo', ' Welt '])
    socket.receive({ type: 'error', error: { code: 'session_idle', message: 'idle' } })
    expect(handlers.onServiceError).toHaveBeenCalledWith('session_idle')
  })

  it('sends the last audio and a commit on stop, and waits for the server to close', async () => {
    const { socket, session, stream, capture, tracks } = setup()
    const started = session.start({ stream, mode: 'onprem' })
    socket.open()
    socket.receive({ type: 'session.created' })
    await started
    const stopping = session.stop()
    await settle()
    expect(capture()?.stopped).toBe(true)
    expect(socket.sent.map((event) => event.type)).toEqual([
      'input_audio_buffer.append',
      'input_audio_buffer.commit'
    ])
    expect(socket.sent[1]).toEqual({ type: 'input_audio_buffer.commit' })
    // Still waiting: the server finishes its transcript first.
    expect(tracks[0]!.stop).not.toHaveBeenCalled()
    socket.finish()
    await stopping
    expect(tracks[0]!.stop).toHaveBeenCalled()
    expect(capture()?.closed).toBe(true)
  })

  it('gives up waiting for the server after the drain timeout', async () => {
    const { socket, session, stream, tracks } = setup()
    const started = session.start({ stream, mode: 'onprem' })
    socket.open()
    socket.receive({ type: 'session.created' })
    await started
    const stopping = session.stop()
    await settle()
    vi.advanceTimersByTime(DRAIN_TIMEOUT_MS)
    await stopping
    expect(tracks[0]!.stop).toHaveBeenCalled()
    expect(socket.closedWith).toBe(1000)
  })

  it('reports a socket that closes while recording, but not one closing on stop', async () => {
    const { socket, session, stream, handlers, tracks } = setup()
    const started = session.start({ stream, mode: 'onprem' })
    socket.open()
    socket.receive({ type: 'session.created' })
    await started
    socket.finish()
    expect(handlers.onConnectionLost).toHaveBeenCalledWith('connectionClosed')
    expect(session.isRecording).toBe(false)
    expect(tracks[0]!.stop).toHaveBeenCalled()
  })

  it('drops audio while the socket does not keep up', async () => {
    const { socket, session, stream, capture } = setup()
    const started = session.start({ stream, mode: 'onprem' })
    socket.open()
    socket.receive({ type: 'session.created' })
    await started
    socket.bufferedAmount = MAX_BUFFERED_BYTES + 1
    capture()!.onFrame(new Uint8Array(4))
    expect(socket.sent).toEqual([])
    expect(session.droppedFrames).toBe(1)
  })

  it('fails a start whose socket closes while the audio is prepared, and frees it all (W-7)', async () => {
    let captured!: () => void
    const captureGate = new Promise<void>((resolve) => {
      captured = resolve
    })
    const { socket, session, stream, tracks, handlers, capture } = setup({ captureGate })
    const started = session.start({ stream, mode: 'onprem' })
    socket.open()
    socket.receive({ type: 'session.created' })
    await settle()
    // The server goes while the worklet loads.
    socket.finish()
    captured()
    await expect(started).rejects.toMatchObject({ code: 'connectionClosed' })
    expect(session.isRecording).toBe(false)
    expect(capture()?.closed).toBe(true)
    expect(tracks[0]!.stop).toHaveBeenCalled()
    // A start that fails is no lost connection.
    expect(handlers.onConnectionLost).not.toHaveBeenCalled()
  })

  it('closes a capture that comes after the page tore the start down (W-7)', async () => {
    let captured!: () => void
    const captureGate = new Promise<void>((resolve) => {
      captured = resolve
    })
    const { socket, session, stream, tracks, capture } = setup({ captureGate })
    const started = session.start({ stream, mode: 'onprem' })
    socket.open()
    socket.receive({ type: 'session.created' })
    await settle()
    session.teardown()
    captured()
    await expect(started).rejects.toMatchObject({ code: 'aborted' })
    expect(capture()?.closed).toBe(true)
    expect(session.isRecording).toBe(false)
    expect(tracks[0]!.stop).toHaveBeenCalled()
  })

  it('ends a start the page overtook', async () => {
    const { socket, session, stream } = setup()
    const started = session.start({ stream, mode: 'onprem' })
    socket.open()
    session.teardown()
    await expect(started).rejects.toMatchObject({ code: 'aborted' })
  })
})
