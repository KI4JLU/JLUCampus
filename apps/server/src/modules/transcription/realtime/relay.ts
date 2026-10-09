import { randomUUID } from 'node:crypto'

import {
  TRANSCRIPTION_LIVE_APPEND_MAX_MS,
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
import { LiveItems } from './items.js'
import {
  appendEvent,
  bytesPerSecond,
  clientEvents,
  commitEvent,
  OPENAI_COMMIT_EMPTY,
  openaiCommitEvent,
  openaiTurnDetection,
  parseClientEvent,
  readUpstreamEvent,
  type UpstreamEvent
} from './protocol.js'

/**
 * One live session (T-59, T-60): the browser's WebSocket on this server and the gateway's realtime
 * WebSocket, with the key on this side only. kiChat's realtime bridge did the same for WebRTC; its
 * protocol and lifecycle carry over (see `protocol.ts`), and so do the rules of the reviews of the
 * Campus bridge: a slot is taken before the gateway is asked and held until every socket of the
 * session is gone, every step before the session runs has a deadline, a session without audio or
 * beyond its lifetime is finalized with its transcript, `keep_open` commits fold into one rotation
 * at a time, every message either side sends counts against a budget before it is parsed, and
 * nothing the gateway says reaches a log or the browser.
 *
 * What the browser hears of an item, in either mode, `LiveItems` decides (`items.ts`): an item is
 * open from its first audio or commit until it ends, once, with its transcript or as failed; of a
 * retired item it still remembers and of ids the gateway never opened nothing reaches the browser,
 * and open items are `pendingMax` at most.
 *
 * vLLM (`onprem`) streams one item per gateway stream: decoding starts after 300 ms of audio
 * (`input_audio_buffer.committed` tells the browser what it may wait for), a final commit ends the
 * stream with `transcription.done`. A `keep_open` commit seals the item and opens the next stream
 * at once; audio meanwhile is held and is the next item's, also when the next stream fails before
 * it gets there. An item with audio whose stream closes before its transcript came, decoding or
 * not, is reported as failed.
 *
 * OpenAI (`openai`) runs one stream. A model with voice detection finds the items itself; for one
 * without (`gpt-realtime-whisper`) the server commits the audio itself, at a quiet frame after
 * `openaiCommitMinMs` and at the latest after `openaiCommitMaxMs`, and settles each of its commits
 * by one answer, once: a `…committed` of a new item (not of an open or retired one) the oldest
 * unanswered, an empty buffer the one its `event_id` names if that is unanswered. Committed items
 * fail after `itemTimeoutMs` without their transcript.
 *
 * Stopping (a commit without `keep_open`) seals what is open, waits up to `doneTimeoutMs` for its
 * transcript and closes the browser's socket normally (1000); an item without its transcript by
 * then is reported as failed. For OpenAI the drain is complete only once the gateway confirmed
 * the end of the audio: without voice detection by answering every commit of the server's, with
 * it by answering a final commit of the server's (its `event_id`) with an empty buffer. Without
 * that confirmation in time the browser gets `upstream_error` and the socket closes with 1011.
 * Errors go to the browser as `error` events with the server's codes before the socket closes.
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
  /** The browser may send this many messages at once… */
  messageBurst: number
  /** …and this many a second on average (100 ms frames are ten). */
  messageRate: number
  /** Messages the gateway may send at once, and a second on average. */
  upstreamMessageBurst: number
  upstreamMessageRate: number
  /** Bytes the gateway may send at once, and a second on average. */
  upstreamByteBurst: number
  upstreamByteRate: number
  /** OpenAI: items awaiting their transcript beyond which the session ends… */
  pendingMax: number
  /** …and how long one may wait for it before it is reported as failed. */
  itemTimeoutMs: number
  /** OpenAI without voice detection: the server commits after this much audio at a quiet frame… */
  openaiCommitMinMs: number
  /** …and after this much at the latest. */
  openaiCommitMaxMs: number
  /** Audio held while a gateway stream opens; beyond, frames are dropped. */
  holdMaxMs: number
  /** Bytes queued for the browser beyond which the session ends (a client that does not read). */
  clientBufferMax: number
  /** Bytes queued for the gateway beyond which the session ends (a gateway that does not read). */
  upstreamBufferMax: number
  /** How often the watchdog looks. */
  watchIntervalMs: number
  /** How often an open socket's access is read again. */
  accessCheckIntervalMs: number
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
  messageBurst: 200,
  messageRate: 50,
  upstreamMessageBurst: 1000,
  upstreamMessageRate: 200,
  upstreamByteBurst: 8 * 1024 * 1024,
  upstreamByteRate: 1024 * 1024,
  pendingMax: 32,
  itemTimeoutMs: 30_000,
  openaiCommitMinMs: 1000,
  openaiCommitMaxMs: 3000,
  holdMaxMs: 30_000,
  clientBufferMax: 1024 * 1024,
  upstreamBufferMax: 2 * 1024 * 1024,
  watchIntervalMs: 1000,
  accessCheckIntervalMs: 60_000
}

/** vLLM starts decoding after this much audio of an item, so deltas stream while speaking. */
const START_DECODING_MS = 300
/** How long the diagnosis of a refused handshake may ask the gateway's model list. */
const CLASSIFY_TIMEOUT_MS = 4000
/** OpenAI takes a commit only with this much audio since the last item. */
const OPENAI_COMMIT_MIN_MS = 100
/** A frame whose last 100 ms stay below this level (RMS of PCM16, about -40 dBFS) is quiet. */
const QUIET_RMS = 330
const QUIET_TAIL_MS = 100
/**
 * OpenAI with voice detection: final commits beyond `pendingMax` plus this many confirm nothing.
 * Each further one follows an `input_audio_buffer.committed`, and beyond `pendingMax` new items
 * the session ends anyway.
 */
const FINAL_COMMIT_SPARE_ROUNDS = 2
/** What a message costs on the wire beyond its base64 audio, for the browser's byte budget. */
const WIRE_OVERHEAD = 256

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
  /**
   * Called once when the session has ended and its sockets are gone (closed, or dropped after
   * `closeMs`; at the latest twice that after the end): frees its slot.
   */
  onEnd: () => void
  /** Re-reads component and function permissions for this socket's user. */
  checkAccess?: () => Promise<boolean>
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
  /** Resolves once its transcript or error came or its stream closed. */
  done: Promise<void>
  resolve: () => void
}

/** Audio on its way: base64 PCM16 and how many bytes it decodes to. */
interface Frame {
  audio: string
  bytes: number
}

/** Held audio, coalesced into chunks of up to `TRANSCRIPTION_LIVE_APPEND_MAX_MS`. */
interface HeldChunk {
  buffer: Buffer
  bytes: number
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** A token bucket: `capacity` at once, refilled by `perSecond`. */
class Budget {
  private tokens: number
  private at = Date.now()

  constructor(
    private readonly capacity: number,
    private readonly perSecond: number
  ) {
    this.tokens = capacity
  }

  take(amount: number): boolean {
    const now = Date.now()
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.at) / 1000) * this.perSecond)
    this.at = now
    if (amount > this.tokens) return false
    this.tokens -= amount
    return true
  }
}

/** The bytes of a message as `ws` hands it over. */
function rawLength(data: RawData): number {
  if (Array.isArray(data)) return data.reduce((sum, part) => sum + part.byteLength, 0)
  return data.byteLength
}

/** Whether the last `QUIET_TAIL_MS` of base64 PCM16 at `rate` bytes a second are quiet. */
export function quietTail(audio: string, rate: number): boolean {
  const pcm = Buffer.from(audio, 'base64')
  const tail = Math.min(pcm.length, Math.round((rate * QUIET_TAIL_MS) / 1000) & ~1)
  if (tail === 0) return false
  let sum = 0
  for (let offset = pcm.length - tail; offset < pcm.length; offset += 2) {
    const sample = pcm.readInt16LE(offset)
    sum += sample * sample
  }
  return Math.sqrt(sum / (tail / 2)) < QUIET_RMS
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
  /** Every gateway socket of the session, open, opening or closing. */
  private readonly upstreams = new Set<WebSocket>()
  /** Gateway handshakes under way, whose sockets `upstreams` does not know yet. */
  private opening = 0

  private phase: 'opening' | 'running' | 'finalizing' | 'closed' = 'opening'
  private readonly startedAt = Date.now()
  private lastAccessCheckAt = this.startedAt
  private accessCheckPending = false
  private lastAudioAt = Date.now()
  /** The browser's budgets: audio (`audioBurstMs`, `audioRateFactor`), messages, wire bytes. */
  private readonly audioBudget: Budget
  private readonly messageBudget: Budget
  private readonly wireBudget: Budget
  /** The gateway's budgets, for all its streams together. */
  private readonly upstreamMessages: Budget
  private readonly upstreamBytes: Budget
  private bytesIn = 0
  private hold: HeldChunk[] = []
  private holdBytes = 0
  private holdDropped = false

  /** The browser's socket closed (`clientClosed`); with no gateway socket left, the slot is free. */
  private clientGone = false
  private released = false
  private readonly cleanup = new Set<NodeJS.Timeout>()

  /** vLLM: the item audio goes to; `null` while a rotation opens the next. */
  private item: Item | null = null
  /** vLLM: during a rotation the next item's id, which audio held meanwhile belongs to. */
  private nextItemId: string | null = null
  private itemSeq = 0
  /** A rotation or the finalization, one at a time. */
  private segment: Promise<void> = Promise.resolve()
  private rotationPending = false
  private rotationAgain = false
  private lastRotationAt = Number.NEGATIVE_INFINITY
  private finalizeRequested = false

  /** OpenAI: its one stream, and whether the gateway finds the turns itself. */
  private stream: WebSocket | null = null
  private streamGone = false
  private readonly vad: boolean
  /** The items of either mode, as the browser hears of them. */
  private readonly items: LiveItems
  /** Audio sent since the server's last commit. */
  private uncommitted = 0
  private commitSeq = 0
  /**
   * Without voice detection: the `event_id`s of the server's commits the gateway has not answered
   * yet, oldest first. Each answer settles one of them, once: a `…committed` of a new item the
   * oldest, an empty buffer the one it names.
   */
  private readonly unanswered = new Set<string>()
  /** `input_audio_buffer.committed` events of new items so far. */
  private committedCount = 0
  /** With voice detection: the final commits, and whether one of them got an empty buffer. */
  private readonly finalCommits = new Set<string>()
  private finalEmpty = false
  /** Wakes `until` when something of the OpenAI stream changed. */
  private changed: (() => void) | null = null

  constructor(private readonly options: LiveSessionOptions) {
    this.limits = { ...DEFAULT_LIVE_LIMITS, ...options.limits }
    this.log = options.log ?? consoleLog(this.id)
    this.mode = options.target.mode
    this.rate = bytesPerSecond(this.mode)
    this.vad = this.mode === 'openai' && openaiTurnDetection(options.target.model) !== null
    const limits = this.limits
    const audioBurst = (this.rate * limits.audioBurstMs) / 1000
    const audioRate = this.rate * limits.audioRateFactor
    this.audioBudget = new Budget(audioBurst, audioRate)
    this.messageBudget = new Budget(limits.messageBurst, limits.messageRate)
    this.wireBudget = new Budget(
      Math.ceil((audioBurst * 4) / 3) + limits.messageBurst * WIRE_OVERHEAD,
      (audioRate * 4) / 3 + limits.messageRate * WIRE_OVERHEAD
    )
    this.upstreamMessages = new Budget(limits.upstreamMessageBurst, limits.upstreamMessageRate)
    this.upstreamBytes = new Budget(limits.upstreamByteBurst, limits.upstreamByteRate)
    this.items = new LiveItems((event) => this.send(event), limits.pendingMax)
  }

  get closed(): boolean {
    return this.phase === 'closed'
  }

  /** Opens the gateway; the browser gets `session.created` once audio may flow. */
  async start(): Promise<void> {
    if (this.closed) return
    // The watchdog comes first: whatever closes the session from here on also clears it.
    this.addTimer(setInterval(() => this.watch(), this.limits.watchIntervalMs))
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
    if (this.closed) return
    this.log('running')
    this.flushHold()
    if (this.closed) return
    if (this.finalizeRequested) void this.finalize()
  }

  /** One message of the browser; its budgets are charged before it is parsed. */
  receive(data: string | ArrayBuffer | Buffer, binary = typeof data !== 'string'): void {
    if (this.closed || this.phase === 'finalizing') return
    const bytes = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength
    if (!this.messageBudget.take(1) || !this.wireBudget.take(bytes)) {
      this.log('messages beyond the budget', { bytes })
      this.end(CLOSE.policy, 'message_rate_exceeded')
      return
    }
    const event = binary ? null : parseClientEvent(String(data), this.mode)
    if (!event) {
      this.log('refused a message', { bytes })
      this.end(CLOSE.policy, 'invalid_event')
      return
    }
    if (event.type === 'ignored') return
    if (event.type === 'commit') {
      if (event.keepOpen) this.requestRotation()
      else this.requestFinalize()
      return
    }
    if (!this.audioBudget.take(event.bytes)) {
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
    if (this.clientGone) return
    this.clientGone = true
    if (!this.closed) {
      this.log('browser closed', { code })
      this.close()
    }
    this.releaseWhenGone()
  }

  /** The browser's socket failed; its close follows. */
  clientFailed(): void {
    if (this.closed) return
    this.log('browser socket failed')
    this.close()
    this.options.client.terminate()
  }

  // ------------------------------------------------------------------ audio

  private append(frame: Frame): void {
    const target = this.mode === 'onprem' ? this.item : this.stream
    if (this.phase !== 'running' || !target || this.hold.length > 0) {
      this.holdFrame(frame)
      return
    }
    this.forward(frame)
  }

  /** Holds a frame, decoded into the last chunk while it has room: one buffer per second. */
  private holdFrame(frame: Frame): void {
    if (this.holdBytes + frame.bytes > (this.rate * this.limits.holdMaxMs) / 1000) {
      if (!this.holdDropped) this.log('held audio full, dropping frames')
      this.holdDropped = true
      return
    }
    const size = (this.rate * TRANSCRIPTION_LIVE_APPEND_MAX_MS) / 1000
    let chunk = this.hold.at(-1)
    if (!chunk || chunk.bytes + frame.bytes > size) {
      chunk = { buffer: Buffer.allocUnsafe(size), bytes: 0 }
      this.hold.push(chunk)
    }
    chunk.bytes += chunk.buffer.write(frame.audio, chunk.bytes, 'base64')
    this.holdBytes += frame.bytes
    // Held during a rotation, it is the next item's audio and has an outcome from now on, even if
    // the next stream fails before it gets there.
    if (this.nextItemId) this.openItem(this.nextItemId, null)
  }

  /** The held audio as frames, in order; the hold is empty afterwards. */
  private takeHold(): Frame[] {
    const frames = this.hold.map((chunk) => ({
      audio: chunk.buffer.toString('base64', 0, chunk.bytes),
      bytes: chunk.bytes
    }))
    this.hold = []
    this.holdBytes = 0
    this.holdDropped = false
    return frames
  }

  /** Hands the held audio on, in order, where it can go now. */
  private flushHold(): void {
    const ready = this.mode === 'onprem' ? this.item : this.stream
    if (this.phase === 'closed' || !ready) return
    for (const frame of this.takeHold()) {
      if (this.closed) return
      this.forward(frame)
    }
  }

  private forward(frame: Frame): void {
    if (this.mode === 'openai') {
      if (!this.stream || !this.upstreamSend(this.stream, appendEvent(frame.audio))) return
      this.uncommitted += frame.bytes
      if (!this.vad && this.phase === 'running') this.commitWhenDue(frame)
      return
    }
    const item = this.item
    if (!item || !this.upstreamSend(item.socket, appendEvent(frame.audio))) return
    item.bytes += frame.bytes
    // An item with audio has an outcome from now on, whether its decoding starts or not.
    if (!this.openItem(item.id, null)) return
    if (!item.decoding && item.bytes >= (this.rate * START_DECODING_MS) / 1000) {
      this.startDecoding(item)
    }
  }

  /** vLLM decodes only after a first commit; the browser learns which item to wait for. */
  private startDecoding(item: Item): void {
    item.decoding = true
    this.upstreamSend(item.socket, commitEvent(false))
    if (this.openItem(item.id, null)) this.items.announce(item.id)
  }

  /**
   * Opens an item (`opened`; a known one stays as it is, `known`); beyond `pendingMax` open items
   * the gateway leaves too many open, and the session ends (`null`).
   */
  private openItem(id: string, deadline: number | null): 'opened' | 'known' | null {
    const result = this.items.track(id, deadline)
    if (result !== 'full') return result
    this.log('gateway leaves too many items open', { items: this.items.size })
    this.items.failAll()
    this.end(CLOSE.error, 'upstream_error')
    return null
  }

  /** OpenAI without voice detection: a turn ends at a quiet frame, or after the longest turn. */
  private commitWhenDue(frame: Frame): void {
    if (this.uncommitted < (this.rate * this.limits.openaiCommitMinMs) / 1000) return
    const longest = this.uncommitted >= (this.rate * this.limits.openaiCommitMaxMs) / 1000
    if (longest || quietTail(frame.audio, this.rate)) this.openaiCommit('turn')
  }

  /** Commits OpenAI's buffer under an id of the server's; `null` if it could not be sent. */
  private openaiCommit(kind: 'turn' | 'rotate' | 'final'): string | null {
    const stream = this.stream
    if (!stream) return null
    this.commitSeq += 1
    const eventId = `${kind}_${this.commitSeq}`
    if (!this.upstreamSend(stream, openaiCommitEvent(eventId))) return null
    this.uncommitted = 0
    if (!this.vad) {
      this.unanswered.add(eventId)
      if (this.unanswered.size > this.limits.pendingMax) {
        this.log('gateway does not answer commits', { commits: this.unanswered.size })
        this.end(CLOSE.error, 'upstream_error')
        return null
      }
    }
    return eventId
  }

  // ---------------------------------------------------------------- gateway

  /** Opens one gateway stream; for vLLM as the item `itemId`. Tracked, so `close` ends it. */
  private async openStream(
    itemId = `item_${this.id}`
  ): Promise<{ socket: WebSocket; item: Item | null }> {
    const open = this.options.open ?? openGateway
    let socket: WebSocket
    this.opening += 1
    try {
      socket = await open(this.options.target, this.abort.signal, this.limits.handshakeMs)
    } catch (error) {
      this.opening -= 1
      this.releaseWhenGone()
      throw error
    }
    // Counted as an upstream before it stops counting as opening, so the slot stays taken.
    if (socket.readyState !== WebSocket.CLOSED) {
      this.upstreams.add(socket)
      socket.once('close', () => {
        this.upstreams.delete(socket)
        this.releaseWhenGone()
      })
    }
    this.opening -= 1
    if (this.closed) {
      closeGateway(socket, this.limits.closeMs)
      throw new Error('Session closed')
    }
    if (this.mode === 'openai') {
      socket.on('message', (data: RawData, binary: boolean) => {
        if (this.upstreamBudget(data) && !binary) {
          this.openaiEvent(readUpstreamEvent('openai', data.toString()))
        }
      })
      socket.once('close', (code: number) => {
        this.streamGone = true
        this.notify()
        this.streamClosed(code)
      })
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
      if (this.upstreamBudget(data) && !binary) {
        this.vllmEvent(item, readUpstreamEvent('onprem', data.toString()))
      }
    })
    socket.once('close', (code: number) => {
      // No outcome yet: `seal` reports an item whose stream closed before its transcript.
      resolve()
      // A stream that ends while its item still takes audio ends the session.
      if (!item.sealing && this.item === item) this.streamClosed(code)
    })
    return { socket, item }
  }

  /** Charges a gateway message to the gateway's budgets; beyond them the session ends. */
  private upstreamBudget(data: RawData): boolean {
    if (this.closed) return false
    if (this.upstreamMessages.take(1) && this.upstreamBytes.take(rawLength(data))) return true
    this.log('gateway sends beyond the budget')
    this.items.failAll()
    this.end(CLOSE.error, 'upstream_error')
    return false
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
    if (this.closed || socket.readyState !== WebSocket.OPEN) return false
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
        this.items.delta(item.id, event.delta)
        return
      case 'completed':
        this.items.complete(item.id, event.transcript)
        item.resolve()
        return
      case 'error':
        // Of the gateway's error only that there was one; the item is resolved for the browser,
        // so a stop does not wait for a transcript that will not come.
        this.items.track(item.id)
        if (this.items.fail(item.id)) this.log('gateway error event', { item: item.id })
        item.resolve()
        return
      default:
        return
    }
  }

  private openaiEvent(event: UpstreamEvent | null): void {
    if (!event || this.closed) return
    switch (event.type) {
      case 'committed': {
        // A repeated or retired id changes nothing, and answers no commit of the server's.
        const opened = this.openItem(event.itemId, Date.now() + this.limits.itemTimeoutMs)
        if (opened !== 'opened') return
        this.committedCount += 1
        // OpenAI answers commits in order; the event does not name the commit.
        const oldest = this.unanswered.values().next()
        if (!oldest.done) this.unanswered.delete(oldest.value)
        this.items.announce(event.itemId)
        this.notify()
        return
      }
      case 'delta':
        // Only for an open item: ids the gateway never committed, or that are retired, keep no
        // state anywhere.
        if (event.itemId) this.items.delta(event.itemId, event.delta)
        return
      case 'completed':
        if (event.itemId) this.items.complete(event.itemId, event.transcript)
        this.notify()
        return
      case 'failed':
        if (event.itemId) this.items.fail(event.itemId)
        this.notify()
        return
      case 'error':
        if (event.code === OPENAI_COMMIT_EMPTY) {
          // The answer to a commit of the server's without audio left; nothing went wrong. It
          // settles the commit it names (`event_id`), if that is unanswered, once; another,
          // repeated or without one settles nothing.
          if (event.eventId !== null) this.unanswered.delete(event.eventId)
          // Only the answer to a final commit confirms the end of the audio.
          if (event.eventId !== null && this.finalCommits.delete(event.eventId)) {
            this.finalEmpty = true
          }
          this.notify()
          return
        }
        this.log('gateway error event')
        this.send(clientEvents.error('upstream_error'))
        return
      default:
        return
    }
  }

  /** OpenAI items that waited longer than `itemTimeoutMs` for their transcript fail. */
  private expireItems(now: number): void {
    for (const itemId of this.items.expire(now)) {
      this.log('no transcript in time', { item: itemId })
    }
  }

  private notify(): void {
    const changed = this.changed
    this.changed = null
    changed?.()
  }

  /** Waits until `condition` holds, the session closes or `deadline` passes. */
  private async until(condition: () => boolean, deadline: number): Promise<boolean> {
    while (!condition()) {
      const left = deadline - Date.now()
      if (this.closed || left <= 0) return false
      const changed = new Promise<void>((resolve) => {
        this.changed = resolve
      })
      await this.within(changed, left)
    }
    return true
  }

  /** The stream audio goes to closed by itself: the session cannot go on. */
  private streamClosed(code: number): void {
    if (this.closed || this.phase === 'finalizing') return
    this.log('gateway closed the stream', { code })
    this.items.failAll()
    this.end(CLOSE.error, 'upstream_closed')
  }

  // -------------------------------------------------------------- lifecycle

  private requestRotation(): void {
    if (this.closed || this.finalizeRequested) return
    if (this.mode === 'openai') {
      // One commit per interval at most; OpenAI ends the current item with it.
      if (!this.stream || this.phase !== 'running') return
      if (Date.now() - this.lastRotationAt < this.limits.rotateMinIntervalMs) return
      if (this.uncommitted < (this.rate * OPENAI_COMMIT_MIN_MS) / 1000) return
      this.lastRotationAt = Date.now()
      this.openaiCommit('rotate')
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
    this.nextItemId = nextId
    try {
      await this.seal(old)
      let next: Item | null
      try {
        next = (await opening).item
      } catch (error) {
        if (this.closed) return
        this.log('next stream failed', { failure: failureText(error) })
        this.items.track(nextId)
        this.items.fail(nextId)
        this.end(CLOSE.error, 'upstream_error')
        return
      }
      if (this.closed || !next) {
        if (next) closeGateway(next.socket, this.limits.closeMs)
        return
      }
      this.item = next
      if (next.socket.readyState !== WebSocket.OPEN) {
        // Fails the next item too if audio was held for it.
        this.streamClosed(1006)
        return
      }
      this.flushHold()
    } finally {
      this.nextItemId = null
    }
  }

  /**
   * Ends an item: its last audio, the final commit, its transcript within `doneTimeoutMs`. An item
   * still open then, its stream closed or nothing in time, is reported as failed, once; also one
   * whose stream was closing already, so that its decoding never started.
   */
  private async seal(item: Item): Promise<void> {
    item.sealing = true
    if (item.socket.readyState === WebSocket.OPEN) {
      if (!item.decoding) this.startDecoding(item)
      this.upstreamSend(item.socket, commitEvent(true))
    }
    const finished = await this.within(item.done, this.limits.doneTimeoutMs)
    if (!this.closed && this.items.isOpen(item.id)) {
      this.log(finished ? 'stream closed before its transcript' : 'no transcript in time', {
        item: item.id
      })
      this.items.fail(item.id)
    }
    this.retire(item.socket)
  }

  /**
   * Closes a sealed item's stream. While another one still closes, it is dropped at once: a
   * session holds the stream it sends to, the next one opening and one closing at most.
   */
  private retire(socket: WebSocket): void {
    const closing = [...this.upstreams].some(
      (other) => other !== socket && other.readyState === WebSocket.CLOSING
    )
    if (closing) socket.terminate()
    else closeGateway(socket, this.limits.closeMs)
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
        const held = this.takeHold()
        if (item) {
          // Held audio is the item's, sent or not: it has an outcome.
          if (held.length > 0 && !this.openItem(item.id, null)) return
          for (const frame of held) {
            if (this.upstreamSend(item.socket, appendEvent(frame.audio))) item.bytes += frame.bytes
          }
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

  /**
   * OpenAI: commits what has not become an item yet, waits until the gateway confirmed that all
   * audio is in items (`audioCommitted`) and then for every open item's transcript. Open items
   * without one by `doneTimeoutMs` fail; audio whose end was not confirmed by then ends the session
   * with `upstream_error` (1011) instead of the normal close.
   */
  private async drainOpenai(): Promise<void> {
    const stream = this.stream
    if (!stream) return
    for (const frame of this.takeHold()) this.forward(frame)
    const deadline = Date.now() + this.limits.doneTimeoutMs
    const committed = await this.audioCommitted(deadline)
    if (committed) await this.until(() => this.streamGone || this.items.size === 0, deadline)
    if (this.closed) return
    if (this.items.size > 0) {
      this.log(this.streamGone ? 'stream closed before its transcripts' : 'no transcript in time', {
        items: this.items.size
      })
      this.items.failAll()
    }
    if (committed || this.closed) return
    this.log(this.streamGone ? 'stream closed before its last commit' : 'last commit not answered')
    this.end(CLOSE.error, 'upstream_error')
  }

  /**
   * Whether the gateway confirmed in time that all audio sent is in items. Without voice
   * detection the server commits what is left and waits until each of its commits is settled;
   * with it, a commit of the gateway's may cross the server's, so the server commits again after
   * every `input_audio_buffer.committed` of a new item until a final commit of its own is answered
   * with an empty buffer. The answer of a commit of the gateway's, however many, confirms nothing.
   */
  private async audioCommitted(deadline: number): Promise<boolean> {
    if (!this.vad) {
      if (this.uncommitted > 0 && !this.openaiCommit('final')) return false
      await this.until(() => this.streamGone || this.unanswered.size === 0, deadline)
      return !this.closed && this.unanswered.size === 0
    }
    const rounds = this.limits.pendingMax + FINAL_COMMIT_SPARE_ROUNDS
    for (let round = 0; !this.finalEmpty; round += 1) {
      if (this.closed || this.streamGone || round >= rounds) return false
      const before = this.committedCount
      const eventId = this.openaiCommit('final')
      if (!eventId) return false
      this.finalCommits.add(eventId)
      const answered = await this.until(
        () => this.streamGone || this.finalEmpty || this.committedCount > before,
        deadline
      )
      if (!answered) return false
    }
    return !this.closed
  }

  /** The watchdog: sessions without audio or beyond their lifetime are finalized. */
  private watch(): void {
    if (this.closed) return
    if (
      this.options.checkAccess &&
      !this.accessCheckPending &&
      Date.now() - this.lastAccessCheckAt >= this.limits.accessCheckIntervalMs
    ) {
      void this.checkAccess()
    }
    if (this.phase !== 'running') return
    const now = Date.now()
    this.expireItems(now)
    if (this.closed || this.finalizeRequested) return
    let verdict: TranscriptionLiveErrorCode | null = null
    if (now - this.startedAt >= this.limits.maxSessionMs) verdict = 'session_expired'
    else if (now - this.lastAudioAt >= this.limits.idleMs) verdict = 'session_idle'
    if (!verdict) return
    this.log('finalizing on its own', { reason: verdict })
    this.send(clientEvents.error(verdict))
    this.requestFinalize()
  }

  private async checkAccess(): Promise<void> {
    this.accessCheckPending = true
    this.lastAccessCheckAt = Date.now()
    try {
      if (!(await this.options.checkAccess!())) this.close(CLOSE.policy, 'permission_revoked')
    } catch {
      this.close(CLOSE.error, 'access_check_failed')
    } finally {
      this.accessCheckPending = false
    }
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
   * Ends everything, once: timers, the gateway streams (open, opening or closing), the browser's
   * socket. The slot stays taken until those sockets are gone: each is dropped if it has not
   * closed after `closeMs`, and the slot is freed twice that after the end at the latest.
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
    this.notify()
    this.hold = []
    this.holdBytes = 0
    this.items.clear()
    const client = this.options.client
    try {
      client.close(closeCode, reason)
    } catch {
      client.terminate()
    }
    this.afterClose(this.limits.closeMs, () => {
      client.terminate()
      for (const socket of this.upstreams) socket.terminate()
      this.afterClose(this.limits.closeMs, () => {
        if (this.released) return
        this.log('sockets did not close', { upstreams: this.upstreams.size })
        this.release()
      })
    })
    this.log('closed', { code: closeCode, reason, seconds: Math.round(this.bytesIn / this.rate) })
    this.releaseWhenGone()
  }

  /** A timer of the cleanup after `close`, which `release` clears. */
  private afterClose(ms: number, run: () => void): void {
    if (this.released) return
    const timer = setTimeout(() => {
      this.cleanup.delete(timer)
      run()
    }, ms)
    timer.unref()
    this.cleanup.add(timer)
  }

  /** Frees the slot once the session has ended and none of its sockets is left. */
  private releaseWhenGone(): void {
    if (!this.closed || this.released) return
    if (!this.clientGone || this.upstreams.size > 0 || this.opening > 0) return
    this.release()
  }

  private release(): void {
    if (this.released) return
    this.released = true
    for (const timer of this.cleanup) clearTimeout(timer)
    this.cleanup.clear()
    this.options.onEnd()
  }

  /** A timer of the running session; none is taken once it has closed. */
  private addTimer(timer: NodeJS.Timeout): boolean {
    if (this.closed) {
      clearTimeout(timer)
      return false
    }
    timer.unref()
    this.timers.add(timer)
    return true
  }

  /** Waits `ms`, or until the session closes. */
  private sleep(ms: number): Promise<void> {
    return this.within(new Promise<void>(() => {}), ms).then(() => undefined)
  }

  /** Whether `promise` settled within `ms`; `false` too when the session closes first. */
  private within(promise: Promise<void>, ms: number): Promise<boolean> {
    if (this.closed) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      const finish = (value: boolean): void => {
        clearTimeout(timer)
        this.timers.delete(timer)
        this.waits.delete(wake)
        resolve(value)
      }
      const wake = (): void => finish(false)
      const timer = setTimeout(wake, ms)
      this.addTimer(timer)
      this.waits.add(wake)
      void promise.then(() => finish(true))
    })
  }
}

/** Sessions at once, in all and per user; a session holds its slot until its sockets are gone. */
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
