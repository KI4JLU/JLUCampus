import type { TranscriptionIceServer, TranscriptionRealtimeMode } from '@justcampus/shared'
import { LiveEventProcessor } from './events'

/**
 * A live transcription session over WebRTC, ported from kiChat's `realtime_transcription.js`
 * (T-59, T-60). The microphone stream goes to the peer, the transcript comes back as OpenAI
 * realtime events on the `oai-events` data channel. `onprem` sends the SDP offer through the Campus
 * server to the admin's bridge; `openai` gets an ephemeral key from the Campus server and offers
 * its SDP to OpenAI's calls endpoint itself. No long-lived key reaches the browser.
 */

/** ICE gathering is awaited this long before the offer goes out with what was gathered. */
export const ICE_GATHERING_TIMEOUT_MS = 5000
/** The audio connection must be up within this; the session fails otherwise. */
export const CONNECTION_TIMEOUT_MS = 15_000
/** Stopping waits this long for transcripts still being generated. */
export const DRAIN_TIMEOUT_MS = 20_000
/** The OpenAI model asked for when neither the server nor the config names one. */
const DEFAULT_OPENAI_MODEL = 'gpt-realtime-whisper'

/**
 * Why a session failed. The codes map to kiChat's English source messages; `detail` carries what
 * the server or OpenAI said, if anything.
 */
export type RealtimeErrorCode =
  | 'connectionFailed'
  | 'connectionClosed'
  | 'connectionTimeout'
  | 'sessionFailed'
  | 'bridgeError'
  | 'openaiError'
  | 'aborted'

export class RealtimeError extends Error {
  constructor(
    readonly code: RealtimeErrorCode,
    readonly detail: string | null = null
  ) {
    super(detail ?? code)
    this.name = 'RealtimeError'
  }
}

/** What the session needs from the server and the browser; tests pass fakes. */
export interface RealtimeDependencies {
  createPeer: (configuration: RTCConfiguration) => RTCPeerConnection
  /** The on-prem bridge's SDP answer, through the Campus server. */
  onpremSignaling: (sdp: string) => Promise<string>
  /** An ephemeral OpenAI key with the endpoint and model to use it with. */
  openaiSession: () => Promise<{ value: string; callsUrl: string; model: string }>
  fetch: typeof fetch
}

export interface RealtimeHandlers {
  /** Text to append to the transcript. */
  onText: (text: string) => void
  /** A transcription or service error; the session goes on. */
  onServiceError: (message: string) => void
  /** The connection dropped while recording, not on `stop`. The session is torn down. */
  onConnectionLost: (code: 'connectionFailed' | 'connectionClosed') => void
}

export interface RealtimeStartOptions {
  stream: MediaStream
  mode: TranscriptionRealtimeMode
  /** ICE servers of the on-prem path; OpenAI brings its own. */
  iceServers: readonly TranscriptionIceServer[]
  /** The transcription model for OpenAI's `session.update`, from the realtime config. */
  openaiModel: string | null
}

export class RealtimeSession {
  private peer: RTCPeerConnection | null = null
  private channel: RTCDataChannel | null = null
  private stream: MediaStream | null = null
  private mode: TranscriptionRealtimeMode = 'onprem'
  private model = DEFAULT_OPENAI_MODEL
  private readonly events = new LiveEventProcessor()
  /** Called when no item is pending any more. */
  private onDrained: (() => void) | null = null
  private stopping: Promise<void> | null = null
  private closed = false
  private recording = false

  constructor(
    private readonly handlers: RealtimeHandlers,
    private readonly dependencies: RealtimeDependencies
  ) {}

  /** Whether the audio connection is up and nothing is stopping it. */
  get isRecording(): boolean {
    return this.recording
  }

  /**
   * Connects `stream` and resolves once audio flows. A failure tears everything down, the
   * microphone included, and rejects with a `RealtimeError`.
   */
  async start(options: RealtimeStartOptions): Promise<void> {
    this.mode = options.mode
    this.stream = options.stream
    this.model = options.openaiModel?.trim() || DEFAULT_OPENAI_MODEL
    try {
      // The TURN relay serves the on-prem path only; OpenAI terminates media on its own servers.
      const peer = this.dependencies.createPeer(
        options.mode === 'openai' || options.iceServers.length === 0
          ? {}
          : { iceServers: options.iceServers.map((server) => ({ urls: [...server.urls] })) }
      )
      this.peer = peer
      const channel = peer.createDataChannel('oai-events')
      this.channel = channel
      channel.addEventListener('message', (event: MessageEvent) => this.receive(event.data))
      channel.addEventListener('open', () => this.sendSessionUpdate())
      for (const track of options.stream.getTracks()) peer.addTrack(track, options.stream)

      await peer.setLocalDescription(await peer.createOffer())
      this.check()
      // The offer before gathering carries no candidates, and nobody trickles: wait for them.
      await this.waitForIceGathering(peer)
      this.check()
      const offer = peer.localDescription?.sdp ?? ''
      const answer =
        options.mode === 'openai'
          ? await this.negotiateOpenai(offer)
          : await this.negotiateOnprem(offer)
      this.check()
      await peer.setRemoteDescription({ type: 'answer', sdp: answer })
      this.check()
      // Only a connected peer carries audio: until then the microphone must not look open.
      await this.waitForConnection(peer)
      this.check()
      this.watchConnection(peer, channel)
      this.recording = true
    } catch (error) {
      this.teardown()
      throw error instanceof RealtimeError
        ? error
        : new RealtimeError('connectionFailed', error instanceof Error ? error.message : null)
    }
  }

  /**
   * Finishes the session: on-prem asks the bridge to finalise, then waits up to
   * `DRAIN_TIMEOUT_MS` for transcripts still pending, then closes channel, peer and microphone.
   * Repeated calls join the first.
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
    // Nobody may keep waiting for results of a closed connection.
    const drained = this.onDrained
    this.onDrained = null
    drained?.()
    this.channel?.close()
    this.channel = null
    this.peer?.close()
    this.peer = null
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    this.stream = null
    this.events.clear()
  }

  private async drainAndClose(): Promise<void> {
    let committed = false
    const channel = this.channel
    if (this.mode === 'onprem' && channel?.readyState === 'open') {
      try {
        // The bridge finalises only when asked, and answers with completed or failed.
        channel.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
        committed = true
      } catch {
        // The channel closed meanwhile; nothing to wait for then.
      }
    }
    if (this.mode === 'onprem' && (committed || this.events.pending.size > 0)) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(finish, DRAIN_TIMEOUT_MS)
        function finish(): void {
          clearTimeout(timer)
          resolve()
        }
        this.onDrained = finish
      })
      this.onDrained = null
    }
    this.teardown()
  }

  private receive(data: unknown): void {
    if (typeof data !== 'string') return
    let event: unknown
    try {
      event = JSON.parse(data)
    } catch {
      return
    }
    const effect = this.events.handle(event)
    if (effect.text) this.handlers.onText(effect.text)
    if (effect.error) this.handlers.onServiceError(effect.error)
    if (effect.drained) this.onDrained?.()
  }

  /** OpenAI needs the transcription session configured; the bridge manages its own. */
  private sendSessionUpdate(attempt = 0): void {
    if (this.mode !== 'openai') return
    const channel = this.channel
    if (!channel) return
    // `open` can fire a tick before `readyState` says so.
    if (channel.readyState !== 'open') {
      if (attempt < 20) setTimeout(() => this.sendSessionUpdate(attempt + 1), 50)
      return
    }
    try {
      channel.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            type: 'transcription',
            audio: { input: { transcription: { model: this.model } } }
          }
        })
      )
    } catch {
      // The channel closed; the session fails on its own.
    }
  }

  private async negotiateOnprem(offer: string): Promise<string> {
    try {
      return await this.dependencies.onpremSignaling(offer)
    } catch (error) {
      throw new RealtimeError('bridgeError', serverMessage(error))
    }
  }

  private async negotiateOpenai(offer: string): Promise<string> {
    let session: { value: string; callsUrl: string; model: string }
    try {
      session = await this.dependencies.openaiSession()
    } catch (error) {
      throw new RealtimeError('sessionFailed', serverMessage(error))
    }
    if (session.model.trim()) this.model = session.model.trim()
    let response: Response
    try {
      response = await this.dependencies.fetch(session.callsUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.value}`, 'Content-Type': 'application/sdp' },
        body: offer,
        credentials: 'omit'
      })
    } catch (error) {
      throw new RealtimeError('openaiError', error instanceof Error ? error.message : null)
    }
    const text = await response.text()
    if (!response.ok) throw new RealtimeError('openaiError', text || `HTTP ${response.status}`)
    return text
  }

  private waitForIceGathering(peer: RTCPeerConnection): Promise<void> {
    if (peer.iceGatheringState === 'complete') return Promise.resolve()
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer)
        peer.removeEventListener('icegatheringstatechange', onChange)
        resolve()
      }
      const onChange = (): void => {
        if (peer.iceGatheringState === 'complete') finish()
      }
      // A stalled gathering goes on with the candidates it has.
      const timer = setTimeout(finish, ICE_GATHERING_TIMEOUT_MS)
      peer.addEventListener('icegatheringstatechange', onChange)
    })
  }

  private waitForConnection(peer: RTCPeerConnection): Promise<void> {
    if (peer.connectionState === 'connected') return Promise.resolve()
    return new Promise((resolve, reject) => {
      const finish = (error?: RealtimeError): void => {
        clearTimeout(timer)
        peer.removeEventListener('connectionstatechange', onChange)
        if (error) reject(error)
        else resolve()
      }
      const onChange = (): void => {
        if (peer.connectionState === 'connected') finish()
        else if (peer.connectionState === 'failed') finish(new RealtimeError('connectionFailed'))
        else if (peer.connectionState === 'closed') finish(new RealtimeError('connectionClosed'))
      }
      const timer = setTimeout(
        () => finish(new RealtimeError('connectionTimeout')),
        CONNECTION_TIMEOUT_MS
      )
      peer.addEventListener('connectionstatechange', onChange)
    })
  }

  /** A connection that drops while recording must not leave a microphone that looks open. */
  private watchConnection(peer: RTCPeerConnection, channel: RTCDataChannel): void {
    const lost = (code: 'connectionFailed' | 'connectionClosed'): void => {
      if (peer !== this.peer || !this.recording || this.stopping) return
      this.teardown()
      this.handlers.onConnectionLost(code)
    }
    peer.addEventListener('connectionstatechange', () => {
      if (peer.connectionState === 'failed') lost('connectionFailed')
      else if (peer.connectionState === 'closed') lost('connectionClosed')
    })
    channel.addEventListener('close', () => lost('connectionClosed'))
  }

  /** Ends a start that was overtaken by `teardown` (the page went away). */
  private check(): void {
    if (this.closed) throw new RealtimeError('aborted')
  }
}

/** What the Campus server said about a failure, if it said anything. */
function serverMessage(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const body = (error as { body?: { error?: { message?: unknown } } | null }).body
  const message = body?.error?.message
  return typeof message === 'string' && message.trim() ? message : null
}
