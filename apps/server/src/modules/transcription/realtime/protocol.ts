import {
  TRANSCRIPTION_LIVE_APPEND_MAX_MS,
  TRANSCRIPTION_REALTIME_SAMPLE_RATES,
  type TranscriptionLiveErrorCode,
  type TranscriptionRealtimeMode
} from '@justcampus/shared'

/**
 * The live WebSocket's two protocols, as pure functions (T-59, T-60).
 *
 * Towards the browser: OpenAI realtime event names, as the web app and kiChat's
 * `realtime_transcription.js` handle them. The browser may send only `input_audio_buffer.append`
 * (base64 PCM16 at the mode's rate) and `input_audio_buffer.commit` (`keep_open: true` goes on
 * with a new item); `session.update` is ignored, as the server sets the session up itself;
 * anything else is refused. It gets `session.created`, `input_audio_buffer.committed`,
 * `conversation.item.input_audio_transcription.delta`, `…completed`, `…failed` and `error`, each
 * with only the fields the web app reads, and errors only with the server's own codes and words.
 *
 * Towards the gateway, per mode. vLLM's realtime endpoint (`onprem`, see
 * vllm/entrypoints/speech_to_text/realtime/): `session.update {model}` with the model at the top
 * level, `input_audio_buffer.append`, `input_audio_buffer.commit {final: false}` to start
 * decoding and `{final: true}` to end the stream; it answers `transcription.delta`,
 * `transcription.done` and `error`. OpenAI Realtime (`openai`): a transcription session with
 * `audio/pcm` at 24 kHz, whose events already carry the names the browser reads. Its turns come
 * from server-side voice detection where the model has it; `gpt-realtime-whisper` has none
 * (`turn_detection: null`), the server commits its audio itself (`openaiTurnDetection`).
 */

/** Bytes of one second of the mode's audio (PCM16 mono). */
export function bytesPerSecond(mode: TranscriptionRealtimeMode): number {
  return TRANSCRIPTION_REALTIME_SAMPLE_RATES[mode] * 2
}

/** What the browser asked for with one message. */
export type ClientEvent =
  | { type: 'append'; audio: string; bytes: number }
  | { type: 'commit'; keepOpen: boolean }
  | { type: 'ignored' }

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * The bytes a base64 text decodes to, or `null` for one that is not canonical base64: its length
 * a multiple of four, padding only at the end, and the bits the padding leaves unused zero
 * (`AAA=`, not `AAB=`), so that the text is exactly what encoding its bytes gives.
 */
export function base64Bytes(text: string): number | null {
  if (text.length % 4 !== 0 || !BASE64.test(text)) return null
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0
  if (padding > 0) {
    const last = BASE64_ALPHABET.indexOf(text.charAt(text.length - padding - 1))
    if (last & (padding === 1 ? 0b11 : 0b1111)) return null
  }
  return (text.length / 4) * 3 - padding
}

function isFields(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * One message of the browser, or `null` for one the server does not take: no JSON object, an
 * event type it does not relay, or audio that is no base64, empty, of an odd number of bytes (no
 * whole PCM16 samples) or longer than `TRANSCRIPTION_LIVE_APPEND_MAX_MS`.
 */
export function parseClientEvent(
  data: string,
  mode: TranscriptionRealtimeMode
): ClientEvent | null {
  let event: unknown
  try {
    event = JSON.parse(data)
  } catch {
    return null
  }
  if (!isFields(event)) return null
  switch (event.type) {
    case 'input_audio_buffer.append': {
      if (typeof event.audio !== 'string') return null
      const bytes = base64Bytes(event.audio)
      const max = (bytesPerSecond(mode) * TRANSCRIPTION_LIVE_APPEND_MAX_MS) / 1000
      if (bytes === null || bytes === 0 || bytes % 2 !== 0 || bytes > max) return null
      return { type: 'append', audio: event.audio, bytes }
    }
    case 'input_audio_buffer.commit':
      return { type: 'commit', keepOpen: event.keep_open === true }
    case 'session.update':
      return { type: 'ignored' }
    default:
      return null
  }
}

/** The gateway's realtime WebSocket for a mode, below its API address up to `/v1`. */
export function realtimeSocketUrl(
  mode: TranscriptionRealtimeMode,
  apiBase: string,
  model: string
): string {
  const base = apiBase
    .replace(/\/+$/, '')
    .replace(/^https:/i, 'wss:')
    .replace(/^http:/i, 'ws:')
  return mode === 'onprem'
    ? `${base}/realtime?model=${encodeURIComponent(model)}`
    : `${base}/realtime?intent=transcription`
}

/**
 * How an OpenAI transcription model finds its turns: `server_vad` where the model has voice
 * detection, `null` for `gpt-realtime-whisper` (and its snapshots), whose turn detection must be
 * left out or `null`; the server commits its audio itself then (`relay.ts`).
 */
export function openaiTurnDetection(model: string): 'server_vad' | null {
  return /^gpt-realtime-whisper(?:$|-)/i.test(model.trim()) ? null : 'server_vad'
}

/** The `session.update` that sets the gateway's session up for transcription with `model`. */
export function sessionUpdate(mode: TranscriptionRealtimeMode, model: string): unknown {
  if (mode === 'onprem') {
    // vLLM refuses audio until it has validated the model; `model` sits at the top level.
    return { type: 'session.update', model }
  }
  const turnDetection = openaiTurnDetection(model)
  return {
    type: 'session.update',
    session: {
      type: 'transcription',
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: TRANSCRIPTION_REALTIME_SAMPLE_RATES.openai },
          transcription: { model },
          turn_detection: turnDetection ? { type: turnDetection } : null
        }
      }
    }
  }
}

/** vLLM: append audio to the stream. */
export function appendEvent(audio: string): unknown {
  return { type: 'input_audio_buffer.append', audio }
}

/** vLLM: start decoding (`final: false`) or end the stream (`final: true`). */
export function commitEvent(final: boolean): unknown {
  return { type: 'input_audio_buffer.commit', final }
}

/** OpenAI: commit the buffer; `eventId` comes back in an `error` the commit causes. */
export function openaiCommitEvent(eventId: string): unknown {
  return { type: 'input_audio_buffer.commit', event_id: eventId }
}

/** What one message of the gateway means for the session. */
export type UpstreamEvent =
  | { type: 'delta'; itemId: string | null; delta: string }
  | { type: 'completed'; itemId: string | null; transcript: string }
  | { type: 'failed'; itemId: string | null }
  | { type: 'committed'; itemId: string }
  | { type: 'sessionUpdated' }
  /**
   * `code` is the gateway's own error code, for the server to decide by; it is never passed on.
   * `eventId` is the id of the server's event that caused it, where the gateway names it.
   */
  | { type: 'error'; code: string | null; eventId: string | null }

/** The longest delta and transcript passed on; a gateway sends far less. */
export const DELTA_MAX = 4000
export const TRANSCRIPT_MAX = 100_000

const ITEM_ID = /^[\w-]{1,100}$/

function itemIdOf(event: Record<string, unknown>): string | null {
  return typeof event.item_id === 'string' && ITEM_ID.test(event.item_id) ? event.item_id : null
}

function textOf(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

/**
 * One message of the gateway in the mode's protocol, or `null` for one the session does not use.
 * Only transcript text is taken from it, cut to its bound; an error keeps the gateway's code for
 * the server's decisions and nothing of its words.
 */
export function readUpstreamEvent(
  mode: TranscriptionRealtimeMode,
  data: string
): UpstreamEvent | null {
  let event: unknown
  try {
    event = JSON.parse(data)
  } catch {
    return null
  }
  if (!isFields(event)) return null
  if (event.type === 'error') {
    const error = isFields(event.error) ? event.error : {}
    const code = typeof error.code === 'string' ? error.code.slice(0, 100) : null
    const eventId =
      typeof error.event_id === 'string' && ITEM_ID.test(error.event_id) ? error.event_id : null
    return { type: 'error', code, eventId }
  }
  if (event.type === 'session.updated') return { type: 'sessionUpdated' }
  if (mode === 'onprem') {
    if (event.type === 'transcription.delta') {
      return { type: 'delta', itemId: null, delta: textOf(event.delta, DELTA_MAX) }
    }
    if (event.type === 'transcription.done') {
      return { type: 'completed', itemId: null, transcript: textOf(event.text, TRANSCRIPT_MAX) }
    }
    return null
  }
  switch (event.type) {
    case 'input_audio_buffer.committed': {
      const itemId = itemIdOf(event)
      return itemId ? { type: 'committed', itemId } : null
    }
    case 'conversation.item.input_audio_transcription.delta':
      return { type: 'delta', itemId: itemIdOf(event), delta: textOf(event.delta, DELTA_MAX) }
    case 'conversation.item.input_audio_transcription.completed':
      return {
        type: 'completed',
        itemId: itemIdOf(event),
        transcript: textOf(event.transcript, TRANSCRIPT_MAX)
      }
    case 'conversation.item.input_audio_transcription.failed':
      return { type: 'failed', itemId: itemIdOf(event) }
    default:
      return null
  }
}

/** OpenAI's answer to a commit without audio since the last one; nothing went wrong. */
export const OPENAI_COMMIT_EMPTY = 'input_audio_buffer_commit_empty'

/** The server's words for each live error code (the web app shows its own). */
const ERROR_MESSAGES: Record<TranscriptionLiveErrorCode, string> = {
  not_set_up: 'This live mode is not set up',
  busy: 'The server takes no more live sessions right now',
  model_not_allowed: 'The gateway does not allow the realtime model for this API key',
  gateway_key_rejected: 'The gateway refused the API key',
  gateway_refused: 'The gateway refused the realtime session',
  gateway_unreachable: 'The server cannot reach the gateway',
  upstream_error: 'The gateway reported an error',
  upstream_closed: 'The gateway closed the realtime session',
  session_idle: 'No audio arrived for too long',
  session_expired: 'The session reached its maximum length',
  invalid_event: 'The server does not take this message',
  audio_rate_exceeded: 'More audio arrived than plays in real time',
  message_rate_exceeded: 'More messages arrived than the server takes'
}

/** Events for the browser, with only the fields it reads. */
export const clientEvents = {
  created: (mode: TranscriptionRealtimeMode) => ({
    type: 'session.created',
    session: { mode, sample_rate: TRANSCRIPTION_REALTIME_SAMPLE_RATES[mode] }
  }),
  committed: (itemId: string) => ({ type: 'input_audio_buffer.committed', item_id: itemId }),
  delta: (itemId: string, delta: string) => ({
    type: 'conversation.item.input_audio_transcription.delta',
    item_id: itemId,
    delta
  }),
  completed: (itemId: string, transcript: string) => ({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: itemId,
    transcript
  }),
  failed: (itemId: string, code: TranscriptionLiveErrorCode = 'upstream_error') => ({
    type: 'conversation.item.input_audio_transcription.failed',
    item_id: itemId,
    error: { code, message: ERROR_MESSAGES[code] }
  }),
  error: (code: TranscriptionLiveErrorCode) => ({
    type: 'error',
    error: { code, message: ERROR_MESSAGES[code] }
  })
}
