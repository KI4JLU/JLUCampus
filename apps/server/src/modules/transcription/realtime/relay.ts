import { randomUUID } from 'node:crypto'

import {
  TRANSCRIPTION_LIVE_UNAVAILABLE_CODES,
  type TranscriptionLiveErrorCode
} from '@justcampus/shared'
import WebSocket, { type RawData } from 'ws'

import {
  closeGateway,
  failureText,
  GatewayRefused,
  openGateway,
  rememberAvailability,
  unavailableReason,
  type RealtimeTarget
} from './gateway.js'
import {
  appendEvent,
  bytesPerSecond,
  clientEvents,
  commitEvent,
  OPENAI_COMMIT_EMPTY,
  parseClientEvent,
  readUpstreamEvent,
  type UpstreamEvent
} from './protocol.js'

/**
 * One live session (T-59, T-60): the browser's WebSocket on this server and the gateway's realtime
 * WebSocket, with the key on this side only. kiChat's realtime bridge did the same for WebRTC; its
 * protocol and lifecycle carry over (see `protocol.ts`), and so do the rules of the reviews of the
 * Campus bridge: a slot is taken before the gateway is asked and freed on every way out, every
 * step before the session runs has a deadline, a session without audio or beyond its lifetime is
 * finalized with its transcript, `keep_open` commits fold into one rotation at a time, and nothing
 * the gateway says reaches a log or the browser.
 *
 * vLLM (`onprem`) streams one item per gateway stream: decoding starts after 300 ms of audio
 * (`input_audio_buffer.committed` tells the browser what it may wait for), a final commit ends the
 * stream with `transcription.done`. A `keep_open` commit seals the item and opens the next stream
 * at once; audio meanwhile is held and goes to the next item. OpenAI (`openai`) finds the items
 * itself in one stream; a commit there ends the current one.
 *
 * Stopping (a commit without `keep_open`) seals what is open, waits up to `doneTimeoutMs` for its
 * transcript and closes the browser's socket normally (1000). Errors go to the browser as `error`
 * events with the server's codes before the socket closes.
 */

/** The browser's socket as the session uses it. */
export interface ClientSocket {
  send(data: string): void
  close(code: number, reason: string): void
  /** Drops the connection without the closing handshake. */
  terminate(): void
  /** Bytes queued and not yet sent (`ws`'s `bufferedAmount`). */
  readonly bufferedAmount: number
}

export interface LiveLimits {
  /** A running session without audio for this long is finalized (`session_idle`). */
  idleMs: number
  /** A session is finalized after this long in all (`session_expired`). */
  maxSessionMs: number
  /** Sealing an item waits this long for its transcript. */
  doneTimeoutMs: number
  /** Opening one gateway stream: connection, upgrade answer, `session.update`. */
  handshakeMs: number
  /** A socket that has not closed gracefully after this is dropped. */
  closeMs: number
  /** Rotations (`keep_open` commits) start at most this often. */
  rotateMinIntervalMs: number
  /** The browser may send this much audio at once beyond real time… */
  audioBurstMs: number
  /** …and this many times real time on average. */
  audioRateFactor: number
  /** Audio held while a gateway stream opens; beyond, frames are dropped. */
  holdMaxMs: number
  /** Bytes queued for the browser beyond which the session ends (a client that does not read). */
  clientBufferMax: number
  /** Bytes queued for the gateway beyond which the session ends (a gateway that does not read). */
  upstreamBufferMax: number
  /** How often the watchdog looks. */
  watchIntervalMs: number
}

export const DEFAULT_LIVE_LIMITS: LiveLimits = {
  idleMs: 60_000,
  maxSessionMs: 4 * 3600_000,
  doneTimeoutMs: 15_000,
  handshakeMs: 10_000,
  closeMs: 5000,
  rotateMinIntervalMs: 1000,
  audioBurstMs: 10_000,
  audioRateFactor: 1.5,
  holdMaxMs: 30_000,
  clientBufferMax: 1024 * 1024,
  upstreamBufferMax: 2 * 1024 * 1024,
  watchIntervalMs: 1000
}

/** vLLM starts decoding after this much audio of an item, so deltas stream while speaking. */
const START_DECODING_MS = 300
/** How long the diagnosis of a refused handshake may ask the gateway's model list. */
const CLASSIFY_TIMEOUT_MS = 4000
/** OpenAI takes a commit only with this much audio since the last item. */
const OPENAI_COMMIT_MIN_MS = 100

/** WebSocket close codes towards the browser. */
export const CLOSE = { normal: 1000, policy: 1008, error: 1011, tryAgain: 1013 } as const

/** A fixed log line: the session's short id, an event and numbers or fixed words only. */
export type LiveLog = (event: string, fields?: Record<string, string | number>) => void

export function consoleLog(id: string): LiveLog {
  return (event, fields = {}) => {
    const details = Object.entries(fields)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ')
    console.info(`Transcription live ${id}: ${event}${details ? ` (${details})` : ''}`)
  }
}

export interface LiveSessionOptions {
  target: RealtimeTarget
  client: ClientSocket
  /** Called once when the session has ended, on every way out: frees its slot. */
  onEnd: () => void
  limits?: Partial<LiveLimits>
  log?: LiveLog
  /** Opens a gateway stream; tests may replace it. */
  open?: (target: RealtimeTarget, signal: AbortSignal, timeoutMs: number) => Promise<WebSocket>
}

/** A vLLM item: its gateway stream and how far it got. */
interface Item {
  id: string
  socket: WebSocket
  bytes: number
  decoding: boolean
  sealing: boolean
  /** Resolves once its transcript came, it failed, or its stream closed. */
  done: Promise<void>
  resolve: () => void
}

interface Held {
  audio: string
  bytes: number
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

export class LiveSession {
  readonly id = randomUUID().slice(0, 8)
  private readonly limits: LiveLimits
  private readonly log: LiveLog
  private readonly mode: RealtimeTarget['mode']
  private readonly rate: number
  private readonly abort = new AbortController()
  private readonly timers = new Set<NodeJS.Timeout>()
  /** Waits (`within`, `sleep`) that `close` ends at once. */
  private readonly waits = new Set<() => void>()
  /** Every gateway socket of the session, open or opening. */
  private readonly upstreams = new Set<WebSocket>()

  private phase: 'opening' | 'running' | 'finalizing' | 'closed' = 'opening'
  private readonly startedAt = Date.now()
  private lastAudioAt = Date.now()
  /** The audio budget (`audioBurstMs`, `audioRateFactor`), in bytes. */
  private tokens: number
  private tokensAt = Date.now()
  private bytesIn = 0
  private hold: Held[] = []
  private holdBytes = 0
  private holdDropped = false

  /** vLLM: the item audio goes to; `null` while a rotation opens the next. */
  private item: Item | null = null
  private itemSeq = 0
  /** A rotation or the finalization, one at a time. */
  private segment: Promise<void> = Promise.resolve()
  private rotationPending = false
  private rotationAgain = false
  private lastRotationAt = Number.NEGATIVE_INFINITY
  private finalizeRequested = false

  /** OpenAI: its one stream, items awaiting their transcript, audio since the last item. */
  private stream: WebSocket | null = null
  private readonly pending = new Set<string>()
  private uncommitted = 0
  private commitAnswered: (() => void) | null = null
  private settled: (() => void) | null = null

  constructor(private readonly options: LiveSessionOptions) {
    this.limits = { ...DEFAULT_LIVE_LIMITS, ...options.limits }
    this.log = options.log ?? consoleLog(this.id)
    this.mode = options.target.mode
    this.rate = bytesPerSecond(this.mode)
    this.tokens = (this.rate * this.limits.audioBurstMs) / 1000
  }

  get closed(): boolean {
    return this.phase === 'closed'
  }

  /** Opens the gateway; the browser gets `session.created` once audio may flow. */
  async start(): Promise<void> {
    this.log('opening', { mode: this.mode })
    let opened: { socket: WebSocket; item: Item | null }
    try {
      opened = await this.openStream()
    } catch (error) {
      if (this.closed) return
      await this.refused(error)
      return
    }
    if (this.closed) return
    if (this.mode === 'onprem') this.item = opened.item
    else this.stream = opened.socket
    this.phase = 'running'
    this.lastAudioAt = Date.now()
    if (this.options.target.mode === 'onprem') rememberAvailability(this.options.target, null)
    this.send(clientEvents.created(this.mode))
    this.log('running')
    this.flushHold()
    const watch = setInterval(() => this.watch(), this.limits.watchIntervalMs)
    watch.unref()
    this.timers.add(watch)
    if (this.finalizeRequested) void this.finalize()
  }

  /** One message of the browser. */
  receive(data: string | ArrayBuffer | Buffer, binary = typeof data !== 'string'): void {
    if (this.closed || this.phase === 'finalizing') return
    const event = binary ? null : parseClientEvent(String(data), this.mode)
    if (!event) {
      this.log('refused a message', { bytes: typeof data === 'string' ? data.length : 0 })
      this.end(CLOSE.policy, 'invalid_event')
      return
    }
    if (event.type === 'ignored') return
    if (event.type === 'commit') {
      if (event.keepOpen) this.requestRotation()
      else this.requestFinalize()
      return
    }
    if (!this.takeTokens(event.bytes)) {
      this.log('audio beyond real time', { bytes: this.bytesIn })
      this.end(CLOSE.policy, 'audio_rate_exceeded')
      return
    }
    this.bytesIn += event.bytes
    this.lastAudioAt = Date.now()
    this.append({ audio: event.audio, bytes: event.bytes })
  }

  /** The browser's socket closed: nobody is left to get a transcript, so everything ends. */
  clientClosed(code: number): void {
    if (this.closed) return
    this.log('browser closed', { code })
    this.close()
  }

  // ------------------------------------------------------------------ audio

  private takeTokens(bytes: number): boolean {
    const now = Date.now()
    const capacity = (this.rate * this.limits.audioBurstMs) / 1000
    this.tokens = Math.min(
      capacity,
      this.tokens + ((now - this.tokensAt) / 1000) * this.rate * this.limits.audioRateFactor
    )
    this.tokensAt = now
    if (bytes > this.tokens) return false
    this.tokens -= bytes
    return true
  }

  private append(frame: Held): void {
    const target = this.mode === 'onprem' ? this.item : this.stream
    if (this.phase !== 'running' || !target || this.hold.length > 0) {
      this.holdFrame(frame)
      return
    }
    this.forward(frame)
  }

  private holdFrame(frame: Held): void {
    if (this.holdBytes + frame.bytes > (this.rate * this.limits.holdMaxMs) / 1000) {
      if (!this.holdDropped) this.log('held audio full, dropping frames')
      this.holdDropped = true
      return
    }
    this.hold.push(frame)
    this.holdBytes += frame.bytes
  }

  /** Hands the held audio on, in order, where it can go now. */
  private flushHold(): void {
    const ready = this.mode === 'onprem' ? this.item : this.stream
    if (this.phase === 'closed' || !ready) return
    const frames = this.hold
    this.hold = []
    this.holdBytes = 0
    this.holdDropped = false
    for (const frame of frames) this.forward(frame)
  }

  private forward(frame: Held): void {
    if (this.mode === 'openai') {
      if (!this.stream || !this.upstreamSend(this.stream, appendEvent(frame.audio))) return
      this.uncommitted += frame.bytes
      return
    }
    const item = this.item
    if (!item || !this.upstreamSend(item.socket, appendEvent(frame.audio))) return
    item.bytes += frame.bytes
    if (!item.decoding && item.bytes >= (this.rate * START_DECODING_MS) / 1000) {
      this.startDecoding(item)
    }
  }

  /** vLLM decodes only after a first commit; the browser learns which item to wait for. */
  private startDecoding(item: Item): void {
    item.decoding = true
    this.upstreamSend(item.socket, commitEvent('onprem', false))
    this.send(clientEvents.committed(item.id))
  }

  // ---------------------------------------------------------------- gateway

  /** Opens one gateway stream; for vLLM as the item `itemId`. Tracked, so `close` ends it. */
  private async openStream(
    itemId = `item_${this.id}`
  ): Promise<{ socket: WebSocket; item: Item | null }> {
    const open = this.options.open ?? openGateway
    const socket = await open(this.options.target, this.abort.signal, this.limits.handshakeMs)
    this.upstreams.add(socket)
    socket.once('close', () => this.upstreams.delete(socket))
    if (this.closed) {
      closeGateway(socket, this.limits.closeMs)
      throw new Error('Session closed')
    }
    if (this.mode === 'openai') {
      socket.on('message', (data: RawData, binary: boolean) => {
        if (!binary) this.openaiEvent(readUpstreamEvent('openai', data.toString()))
      })
      socket.once('close', (code: number) => this.streamClosed(code))
      return { socket, item: null }
    }
    const { promise, resolve } = deferred()
    const item: Item = {
      id: itemId,
      socket,
      bytes: 0,
      decoding: false,
      sealing: false,
      done: promise,
      resolve
    }
    socket.on('message', (data: RawData, binary: boolean) => {
      if (!binary) this.vllmEvent(item, readUpstreamEvent('onprem', data.toString()))
    })
    socket.once('close', (code: number) => {
      resolve()
      // A stream that ends while its item still takes audio ends the session.
      if (!item.sealing && this.item === item) this.streamClosed(code)
    })
    return { socket, item }
  }

  /** Why the gateway refused, to the browser as a code and to the live tab's config. */
  private async refused(error: unknown): Promise<void> {
    const target = this.options.target
    // The model list that tells a refused key from a refused model has a few seconds, so the
    // browser hears why within its own deadline (handshake 10 s, browser 15 s).
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(CLASSIFY_TIMEOUT_MS)])
    const reason = await unavailableReason(error, target, signal).catch(
      () => 'gatewayRefused' as const
    )
    this.log('gateway refused', {
      reason,
      ...(error instanceof GatewayRefused ? { status: error.status } : {}),
      failure: failureText(error)
    })
    if (target.mode === 'onprem') rememberAvailability(target, { reason, model: target.model })
    this.end(CLOSE.error, TRANSCRIPTION_LIVE_UNAVAILABLE_CODES[reason])
  }

  /** Sends to the gateway unless it does not keep up; then the session ends. */
  private upstreamSend(socket: WebSocket, event: unknown): boolean {
    if (socket.readyState !== WebSocket.OPEN) return false
    if (socket.bufferedAmount > this.limits.upstreamBufferMax) {
      this.log('gateway does not keep up', { queued: socket.bufferedAmount })
      this.end(CLOSE.error, 'upstream_error')
      return false
    }
    socket.send(JSON.stringify(event))
    return true
  }

  private vllmEvent(item: Item, event: UpstreamEvent | null): void {
    if (!event || this.closed) return
    switch (event.type) {
      case 'delta':
        if (event.delta) this.send(clientEvents.delta(item.id, event.delta))
        return
      case 'completed':
        this.send(clientEvents.completed(item.id, event.transcript))
        item.resolve()
        return
      case 'error':
        // Of the gateway's error only that there was one; the item is resolved for the browser,
        // so a stop does not wait for a transcript that will not come.
        this.log('gateway error event', { item: item.id })
        this.send(clientEvents.failed(item.id))
        item.resolve()
        return
      default:
        return
    }
  }

  private openaiEvent(event: UpstreamEvent | null): void {
    if (!event || this.closed) return
    switch (event.type) {
      case 'committed':
        this.pending.add(event.itemId)
        this.uncommitted = 0
        this.commitAnswered?.()
        this.send(clientEvents.committed(event.itemId))
        return
      case 'delta':
        if (event.itemId && event.delta) this.send(clientEvents.delta(event.itemId, event.delta))
        return
      case 'completed':
        if (!event.itemId) return
        this.pending.delete(event.itemId)
        this.send(clientEvents.completed(event.itemId, event.transcript))
        this.checkSettled()
        return
      case 'failed':
        if (!event.itemId) return
        this.pending.delete(event.itemId)
        this.send(clientEvents.failed(event.itemId))
        this.checkSettled()
        return
      case 'error':
        if (event.code === OPENAI_COMMIT_EMPTY) {
          this.commitAnswered?.()
          return
        }
        this.log('gateway error event')
        this.send(clientEvents.error('upstream_error'))
        return
      default:
        return
    }
  }

  private checkSettled(): void {
    if (this.pending.size === 0) this.settled?.()
  }

  /** The stream audio goes to closed by itself: the session cannot go on. */
  private streamClosed(code: number): void {
    if (this.closed || this.phase === 'finalizing') return
    this.log('gateway closed the stream', { code })
    this.end(CLOSE.error, 'upstream_closed')
  }

  // -------------------------------------------------------------- lifecycle

  private requestRotation(): void {
    if (this.closed || this.finalizeRequested) return
    if (this.mode === 'openai') {
      // One commit per interval at most; OpenAI ends the current item with it.
      if (!this.stream || Date.now() - this.lastRotationAt < this.limits.rotateMinIntervalMs) return
      if (this.uncommitted < (this.rate * OPENAI_COMMIT_MIN_MS) / 1000) return
      this.lastRotationAt = Date.now()
      this.upstreamSend(this.stream, commitEvent('openai', false))
      return
    }
    if (this.rotationPending) {
      this.rotationAgain = true
      return
    }
    this.rotationPending = true
    void this.rotations()
  }

  /** Rotations one after the other, the ones asked for meanwhile folded into one. */
  private async rotations(): Promise<void> {
    try {
      for (;;) {
        const wait = this.lastRotationAt + this.limits.rotateMinIntervalMs - Date.now()
        if (wait > 0) await this.sleep(wait)
        if (this.closed || this.finalizeRequested) return
        this.lastRotationAt = Date.now()
        const run = this.segment.then(() => this.rotate())
        this.segment = run.catch(() => undefined)
        await run
        if (!this.rotationAgain) return
        this.rotationAgain = false
      }
    } finally {
      this.rotationPending = false
      this.rotationAgain = false
    }
  }

  /**
   * Seals the current item and goes on with the next on a fresh stream, opened while the old one
   * finishes. Audio meanwhile is held and goes to the new item; every event of the new item comes
   * after the old one's transcript.
   */
  private async rotate(): Promise<void> {
    const old = this.item
    if (!old || this.phase !== 'running') return
    this.item = null
    this.itemSeq += 1
    const nextId = `item_${this.id}_${this.itemSeq}`
    this.log('rotating', { seconds: Math.round(old.bytes / this.rate) })
    const opening = this.openStream(nextId)
    opening.catch(() => undefined)
    await this.seal(old)
    let next: Item | null
    try {
      next = (await opening).item
    } catch (error) {
      if (this.closed) return
      this.log('next stream failed', { failure: failureText(error) })
      this.send(clientEvents.failed(nextId))
      this.end(CLOSE.error, 'upstream_error')
      return
    }
    if (this.closed || !next) {
      if (next) closeGateway(next.socket, this.limits.closeMs)
      return
    }
    this.item = next
    if (next.socket.readyState !== WebSocket.OPEN) {
      this.streamClosed(1006)
      return
    }
    this.flushHold()
  }

  /** Ends an item: its last audio, the final commit, its transcript within `doneTimeoutMs`. */
  private async seal(item: Item): Promise<void> {
    item.sealing = true
    if (item.socket.readyState === WebSocket.OPEN) {
      if (!item.decoding) this.startDecoding(item)
      this.upstreamSend(item.socket, commitEvent('onprem', true))
    }
    const finished = await this.within(item.done, this.limits.doneTimeoutMs)
    if (!finished && !this.closed) {
      this.log('no transcript in time', { item: item.id })
      this.send(clientEvents.failed(item.id))
    }
    closeGateway(item.socket, this.limits.closeMs)
  }

  private requestFinalize(): void {
    if (this.closed || this.finalizeRequested) return
    this.finalizeRequested = true
    // Before the gateway took the session there is nothing to seal; `start` finalizes then.
    if (this.phase === 'running') void this.finalize()
  }

  /** Stopping: what is open is sealed, its transcript sent, the socket closed normally. */
  private async finalize(): Promise<void> {
    const run = this.segment.then(async () => {
      if (this.closed) return
      this.phase = 'finalizing'
      this.log('finalizing', { seconds: Math.round(this.bytesIn / this.rate) })
      if (this.mode === 'onprem') {
        // Held audio of a rotation goes to the item it waited for.
        const item = this.item
        if (item) {
          for (const frame of this.hold) {
            this.upstreamSend(item.socket, appendEvent(frame.audio))
            item.bytes += frame.bytes
          }
          this.hold = []
          await this.seal(item)
        }
      } else {
        await this.drainOpenai()
      }
      this.end(CLOSE.normal, null)
    })
    this.segment = run.catch(() => undefined)
    await run
  }

  /** OpenAI: commits what has not become an item yet and waits for every transcript pending. */
  private async drainOpenai(): Promise<void> {
    const stream = this.stream
    if (!stream) return
    for (const frame of this.hold) {
      if (this.upstreamSend(stream, appendEvent(frame.audio))) this.uncommitted += frame.bytes
    }
    this.hold = []
    const deadline = Date.now() + this.limits.doneTimeoutMs
    if (this.uncommitted >= (this.rate * OPENAI_COMMIT_MIN_MS) / 1000) {
      const answered = new Promise<void>((resolve) => {
        this.commitAnswered = resolve
      })
      this.upstreamSend(stream, commitEvent('openai', false))
      await this.within(answered, this.limits.doneTimeoutMs)
      this.commitAnswered = null
    }
    if (this.pending.size > 0) {
      const settled = new Promise<void>((resolve) => {
        this.settled = resolve
      })
      const finished = await this.within(settled, Math.max(0, deadline - Date.now()))
      this.settled = null
      if (!finished && !this.closed) {
        this.log('no transcript in time', { items: this.pending.size })
        for (const itemId of this.pending) this.send(clientEvents.failed(itemId))
        this.pending.clear()
      }
    }
  }

  /** The watchdog: sessions without audio or beyond their lifetime are finalized. */
  private watch(): void {
    if (this.phase !== 'running' || this.finalizeRequested) return
    const now = Date.now()
    let verdict: TranscriptionLiveErrorCode | null = null
    if (now - this.startedAt >= this.limits.maxSessionMs) verdict = 'session_expired'
    else if (now - this.lastAudioAt >= this.limits.idleMs) verdict = 'session_idle'
    if (!verdict) return
    this.log('finalizing on its own', { reason: verdict })
    this.send(clientEvents.error(verdict))
    this.requestFinalize()
  }

  /** Sends to the browser unless it does not read; then the session ends. */
  private send(event: unknown): void {
    if (this.closed) return
    if (this.options.client.bufferedAmount > this.limits.clientBufferMax) {
      this.log('browser does not read', { queued: this.options.client.bufferedAmount })
      this.close()
      this.options.client.terminate()
      return
    }
    this.options.client.send(JSON.stringify(event))
  }

  /** Ends the session, the browser told why first if `code` names an error. */
  private end(closeCode: number, code: TranscriptionLiveErrorCode | null): void {
    if (this.closed) return
    if (code) this.send(clientEvents.error(code))
    this.close(closeCode, code ?? 'done')
  }

  /**
   * Releases everything, once: timers, the gateway streams (open or opening), the browser's socket
   * (dropped if it does not close in time) and the slot.
   */
  close(closeCode: number = CLOSE.normal, reason = 'done'): void {
    if (this.closed) return
    this.phase = 'closed'
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    for (const wake of this.waits) wake()
    this.waits.clear()
    this.abort.abort(new Error('Session closed'))
    for (const socket of this.upstreams) closeGateway(socket, this.limits.closeMs)
    this.item?.resolve()
    this.commitAnswered?.()
    this.settled?.()
    this.hold = []
    const client = this.options.client
    try {
      client.close(closeCode, reason)
    } catch {
      client.terminate()
    }
    setTimeout(() => client.terminate(), this.limits.closeMs).unref()
    this.log('closed', { code: closeCode, reason, seconds: Math.round(this.bytesIn / this.rate) })
    this.options.onEnd()
  }

  /** Waits `ms`, or until the session closes. */
  private sleep(ms: number): Promise<void> {
    return this.within(new Promise<void>(() => {}), ms).then(() => undefined)
  }

  /** Whether `promise` settled within `ms`; `false` too when the session closes first. */
  private within(promise: Promise<void>, ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const finish = (value: boolean): void => {
        clearTimeout(timer)
        this.timers.delete(timer)
        this.waits.delete(wake)
        resolve(value)
      }
      const wake = (): void => finish(false)
      const timer = setTimeout(wake, ms)
      this.timers.add(timer)
      this.waits.add(wake)
      void promise.then(() => finish(true))
    })
  }
}

/** Sessions at once, in all and per user; a session holds its slot from start to end. */
export class SessionSlots {
  private total = 0
  private readonly perUser = new Map<string, number>()

  constructor(
    readonly maxTotal: number,
    readonly maxPerUser: number
  ) {}

  /** A slot for `userId`, or `null` while the server or the user holds as many as allowed. */
  reserve(userId: string): (() => void) | null {
    const mine = this.perUser.get(userId) ?? 0
    if (this.total >= this.maxTotal || mine >= this.maxPerUser) return null
    this.total += 1
    this.perUser.set(userId, mine + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      this.total -= 1
      const left = (this.perUser.get(userId) ?? 1) - 1
      if (left > 0) this.perUser.set(userId, left)
      else this.perUser.delete(userId)
    }
  }

  get active(): number {
    return this.total
  }
}
