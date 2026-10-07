import {
  TRANSCRIPTION_API,
  TRANSCRIPTION_EVENT_NAMES,
  TRANSCRIPTION_EVENTS_RETRY_MS,
  transcriptionEventSchemas,
  type TranscriptionEvent,
  type TranscriptionEventName
} from '@justcampus/shared'
import { apiBase } from '@/lib/api'

/**
 * The module's server-sent events (`TRANSCRIPTION_API.events`) in place of polling: one stream per
 * page serves every job and transcript. It opens with the first subscriber and closes shortly after
 * the last. Events missed while the stream was down are not sent again, so subscribers sync after
 * each (re)connect: the `jobs` snapshot does that for the job list, everyone else fetches what they
 * follow once.
 */

/** What the client needs of an `EventSource`; tests hand in a fake. */
export interface EventStream {
  readonly readyState: number
  addEventListener(type: string, listener: (event: Event) => void): void
  close(): void
}

export interface TranscriptionEventHandlers {
  /** Every event while subscribed. */
  onEvent?: (event: TranscriptionEvent) => void
  /**
   * The stream (re)connected, so events may have been missed: sync now. Also called once right
   * after subscribing when the stream is open already.
   */
  onOpen?: () => void
}

export interface TranscriptionEvents {
  /** Listens until the returned function is called; the first subscriber opens the stream. */
  subscribe(handlers: TranscriptionEventHandlers): () => void
}

export interface TranscriptionEventsOptions {
  /** Opens a new stream. */
  connect: () => EventStream
  /** First wait before connecting again once the browser gave up; it doubles up to `maxRetryMs`. */
  retryMs?: number
  maxRetryMs?: number
  /** How long the stream stays open after the last subscriber left, e.g. while the page changes. */
  graceMs?: number
}

const CLOSED = 2
const MAX_RETRY_MS = 60_000
const GRACE_MS = 2000

/** An event's JSON `data` checked against the contract; `null` for anything else. */
export function parseTranscriptionEvent(
  type: TranscriptionEventName,
  data: unknown
): TranscriptionEvent | null {
  if (typeof data !== 'string') return null
  let json: unknown
  try {
    json = JSON.parse(data)
  } catch {
    return null
  }
  const parsed = transcriptionEventSchemas[type].safeParse(json)
  return parsed.success ? ({ type, data: parsed.data } as TranscriptionEvent) : null
}

/**
 * A ref-counted stream. The browser reconnects by itself after a dropped connection (the server
 * ends each stream after a few minutes on purpose); it gives up when a reconnect is answered with
 * an error status (`401`, `502`, …) and leaves the stream `CLOSED`. Then this connects anew,
 * waiting `retryMs` first and twice as long after each failure, at most `maxRetryMs`.
 */
export function createTranscriptionEvents(
  options: TranscriptionEventsOptions
): TranscriptionEvents {
  const retryMs = options.retryMs ?? TRANSCRIPTION_EVENTS_RETRY_MS
  const maxRetryMs = options.maxRetryMs ?? MAX_RETRY_MS
  const graceMs = options.graceMs ?? GRACE_MS
  const subscribers = new Set<TranscriptionEventHandlers>()
  let stream: EventStream | null = null
  let open = false
  let delay = retryMs
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let closeTimer: ReturnType<typeof setTimeout> | null = null

  const each = (call: (handlers: TranscriptionEventHandlers) => void): void => {
    for (const handlers of [...subscribers]) if (subscribers.has(handlers)) call(handlers)
  }

  const connect = (): void => {
    const current = options.connect()
    stream = current
    current.addEventListener('open', () => {
      if (stream !== current) return
      open = true
      delay = retryMs
      each((handlers) => handlers.onOpen?.())
    })
    current.addEventListener('error', () => {
      if (stream !== current) return
      open = false
      if (current.readyState !== CLOSED) return
      current.close()
      stream = null
      retryTimer = setTimeout(() => {
        retryTimer = null
        if (subscribers.size > 0) connect()
      }, delay)
      delay = Math.min(delay * 2, maxRetryMs)
    })
    for (const name of TRANSCRIPTION_EVENT_NAMES) {
      current.addEventListener(name, (message) => {
        if (stream !== current) return
        const event = parseTranscriptionEvent(name, 'data' in message ? message.data : undefined)
        if (event) each((handlers) => handlers.onEvent?.(event))
      })
    }
  }

  const shutDown = (): void => {
    closeTimer = null
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
    stream?.close()
    stream = null
    open = false
    delay = retryMs
  }

  return {
    subscribe(handlers) {
      subscribers.add(handlers)
      if (closeTimer) clearTimeout(closeTimer)
      closeTimer = null
      if (!stream && !retryTimer) connect()
      else if (open) {
        queueMicrotask(() => {
          if (open && subscribers.has(handlers)) handlers.onOpen?.()
        })
      }
      return () => {
        if (!subscribers.delete(handlers) || subscribers.size > 0) return
        if (closeTimer) clearTimeout(closeTimer)
        closeTimer = setTimeout(shutDown, graceMs)
      }
    }
  }
}

let shared: TranscriptionEvents | null = null

/**
 * The page's stream. The session cookie goes along also when the API is on another origin
 * (desktop app, development).
 */
export function transcriptionEvents(): TranscriptionEvents {
  shared ??= createTranscriptionEvents({
    connect: () =>
      new EventSource(`${apiBase()}${TRANSCRIPTION_API.events}`, { withCredentials: true })
  })
  return shared
}
