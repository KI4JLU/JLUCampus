import {
  isTranscriptionLiveErrorCode,
  TRANSCRIPTION_REALTIME_SAMPLE_RATES,
  type TranscriptionLiveErrorCode,
  type TranscriptionRealtimeMode
} from '@justcampus/shared'
import { LiveEventProcessor } from './events'
import { toBase64 } from './pcm'

/**
 * A live transcription session over the Campus server's WebSocket (T-59, T-60), after kiChat's
 * `realtime_transcription.js`. The microphone goes as PCM16 frames (`input_audio_buffer.append`)
 * to `TRANSCRIPTION_API.realtimeLive`, which relays them to the gateway or OpenAI with the key it
 * holds; the transcript comes back as OpenAI realtime events. Nothing but the app's own API origin
 * is reached, and no key reaches the browser.
 */

/** The server must have taken the session within this; it fails otherwise. */
export const CONNECTION_TIMEOUT_MS = 15_000
/** Stopping waits this long for transcripts still being generated. */
export const DRAIN_TIMEOUT_MS = 20_000
/**
 * Audio queued in the socket beyond this is dropped instead of sent: a connection that stalls
 * must not fill the memory, and the server could not use audio that late anyway.
 */
export const MAX_BUFFERED_BYTES = 1024 * 1024

/**
 * Why a session failed. `refused`: the server said why before the session ran, `detail` is its
 * code (`TRANSCRIPTION_LIVE_ERROR_CODES`); `audioFailed`: the audio processing could not start.
 */
export type RealtimeErrorCode =
  | 'connectionFailed'
  | 'connectionClosed'
  | 'connectionTimeout'
  | 'refused'
  | 'audioFailed'
  | 'aborted'

export class RealtimeError extends Error {
  constructor(
    readonly code: RealtimeErrorCode,
    readonly detail: TranscriptionLiveErrorCode | null = null
  ) {
    super(detail ?? code)
    this.name = 'RealtimeError'
  }
}

/** A running capture of the microphone (`audio.ts`). */
export interface AudioCapture {
  stop: () => Promise<void>
  close: () => void
}

/** What the session needs from the browser; tests pass fakes. */
export interface RealtimeDependencies {
  /** The live WebSocket of the server for a mode. */
  openSocket: (mode: TranscriptionRealtimeMode) => WebSocket
  /** Starts posting the stream's audio as PCM16 frames at `sampleRate`. */
  capture: (
    stream: MediaStream,
    sampleRate: number,
    onFrame: (pcm: Uint8Array) => void
  ) => Promise<AudioCapture>
}

export interface RealtimeHandlers {
  /** Text to append to the transcript. */
  onText: (text: string) => void
  /** A transcription or service error: one of the server's codes, else its words. */
  onServiceError: (message: string) => void
  /** The connection dropped while recording, not on `stop`. The session is torn down. */
  onConnectionLost: (code: 'connectionFailed' | 'connectionClosed') => void
}

export interface RealtimeStartOptions {
  stream: MediaStream
  mode: TranscriptionRealtimeMode
}

export class RealtimeSession {
  private socket: WebSocket | null = null
  private capture: AudioCapture | null = null
  private stream: MediaStream | null = null
  private readonly events = new LiveEventProcessor()
  /** Called once the server has taken the session, or with why not. */
  private onReady: ((error?: RealtimeError) => void) | null = null
  /** Called when the socket closes. */
  private onClosed: (() => void) | null = null
  private stopping: Promise<void> | null = null
  private closed = false
  /** The socket closed; a start still preparing the audio fails then. */
  private socketClosed = false
  private recording = false
  /** Frames dropped because the socket did not keep up. */
  private dropped = 0

  constructor(
    private readonly handlers: RealtimeHandlers,
    private readonly dependencies: RealtimeDependencies
  ) {}

  /** Whether audio flows and nothing is stopping it. */
  get isRecording(): boolean {
    return this.recording
  }

  /** Frames dropped so far because the connection did not keep up. */
  get droppedFrames(): number {
    return this.dropped
  }

  /**
   * Connects and resolves once the server took the session and audio flows. A failure tears
   * everything down, the microphone included, and rejects with a `RealtimeError`; so does a
   * socket that closes while the audio is being prepared (`connectionClosed`), and a teardown
   * meanwhile (`aborted`). A capture that comes after either is closed at once.
   */
  async start(options: RealtimeStartOptions): Promise<void> {
    this.stream = options.stream
    try {
      const socket = this.dependencies.openSocket(options.mode)
      this.socket = socket
      await this.ready(socket)
      this.check()
      let capture: AudioCapture
      try {
        capture = await this.dependencies.capture(
          options.stream,
          TRANSCRIPTION_REALTIME_SAMPLE_RATES[options.mode],
          (pcm) => this.sendFrame(pcm)
        )
      } catch {
        throw new RealtimeError('audioFailed')
      }
      if (this.closed || this.socketClosed) {
        capture.close()
        this.check()
      }
      this.capture = capture
      this.recording = true
    } catch (error) {
      this.teardown()
      throw error instanceof RealtimeError ? error : new RealtimeError('connectionFailed')
    }
  }

  /**
   * Finishes the session: the last audio goes out, the server is asked to finalise
   * (`input_audio_buffer.commit`) and closes the socket once the last transcript is sent; this
   * waits for that at most `DRAIN_TIMEOUT_MS`, then closes socket and microphone. Repeated calls
   * join the first.
   */
  stop(): Promise<void> {
    this.stopping ??= this.drainAndClose().finally(() => {
      this.stopping = null
    })
    return this.stopping
  }

  /** Closes everything at once, without waiting for transcripts. */
  teardown(): void {
    this.closed = true
    this.recording = false
    // A start still waiting learns first that it was overtaken.
    this.onReady?.(new RealtimeError('aborted'))
    this.capture?.close()
    this.capture = null
    const socket = this.socket
    this.socket = null
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      try {
        socket.close(1000)
      } catch {
        // Closing already.
      }
    }
    this.onClosed?.()
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    this.stream = null
    this.events.clear()
  }

  private async drainAndClose(): Promise<void> {
    this.recording = false
    const capture = this.capture
    this.capture = null
    try {
      await capture?.stop()
    } catch {
      // The audio is gone; what reached the server still gets transcribed.
    } finally {
      capture?.close()
    }
    const socket = this.socket
    if (socket?.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
        await new Promise<void>((resolve) => {
          const timer = setTimeout(finish, DRAIN_TIMEOUT_MS)
          function finish(): void {
            clearTimeout(timer)
            resolve()
          }
          this.onClosed = finish
        })
      } catch {
        // The socket closed meanwhile; nothing to wait for then.
      }
      this.onClosed = null
    }
    this.teardown()
  }

  /** Waits for `session.created`, or why the server will not take the session. */
  private ready(socket: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => finish(new RealtimeError('connectionTimeout')),
        CONNECTION_TIMEOUT_MS
      )
      const finish = (error?: RealtimeError): void => {
        clearTimeout(timer)
        this.onReady = null
        if (error) reject(error)
        else resolve()
      }
      this.onReady = finish
      let opened = false
      socket.addEventListener('open', () => {
        opened = true
      })
      socket.addEventListener('message', (event: MessageEvent) => this.receive(event.data))
      socket.addEventListener('close', () => {
        this.socketClosed = true
        // Before the session ran: the server refused the upgrade or closed before it said why.
        this.onReady?.(new RealtimeError(opened ? 'connectionClosed' : 'connectionFailed'))
        this.onClosed?.()
        this.lost()
      })
    })
  }

  private sendFrame(pcm: Uint8Array): void {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.dropped += 1
      return
    }
    socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: toBase64(pcm) }))
  }

  private receive(data: unknown): void {
    if (typeof data !== 'string') return
    let event: unknown
    try {
      event = JSON.parse(data)
    } catch {
      return
    }
    if (typeof event === 'object' && event !== null && 'type' in event) {
      if (event.type === 'session.created') {
        this.onReady?.()
        return
      }
      // An error before the session ran is why it will not.
      if (event.type === 'error' && this.onReady) {
        const code = errorCode(event)
        this.onReady(
          code ? new RealtimeError('refused', code) : new RealtimeError('connectionFailed')
        )
        return
      }
    }
    const effect = this.events.handle(event)
    if (effect.text) this.handlers.onText(effect.text)
    if (effect.error) this.handlers.onServiceError(effect.error)
  }

  /** A socket that closes while recording must not leave a microphone that looks open. */
  private lost(): void {
    if (!this.recording || this.stopping) return
    this.teardown()
    this.handlers.onConnectionLost('connectionClosed')
  }

  /**
   * Ends a start that was overtaken by `teardown` (the page went away) or whose socket closed
   * meanwhile.
   */
  private check(): void {
    if (this.closed) throw new RealtimeError('aborted')
    if (this.socketClosed) throw new RealtimeError('connectionClosed')
  }
}

/** The server's code in an `error` event, if it is one of its codes. */
function errorCode(event: object): TranscriptionLiveErrorCode | null {
  const error = (event as { error?: { code?: unknown } }).error
  const code = typeof error?.code === 'string' ? error.code : null
  return code && isTranscriptionLiveErrorCode(code) ? code : null
}
