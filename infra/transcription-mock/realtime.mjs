import { WebSocketServer } from 'ws'

import { sendJson } from './http.mjs'

/**
 * Live transcription, below `/realtime`: the gateway's realtime WebSocket as vLLM speaks it behind
 * the HRZ LiteLLM gateway (`/realtime/v1/realtime?model=…`, gateway address
 * `http://localhost:9200/realtime/v1`), and OpenAI Realtime's
 * (`/realtime/openai/v1/realtime?intent=transcription`, API address
 * `http://localhost:9200/realtime/openai/v1`), each with its model list (`GET …/models`) for the
 * server's diagnosis of a refusal.
 *
 * Nothing is recognised. Every `ITEM_SECONDS` of audio the next sentence of a fixed German script
 * comes word by word as a delta, as both protocols send it:
 * - vLLM: `session.update {model}` first; decoding starts with `input_audio_buffer.commit
 *   {final: false}`, then `transcription.delta` per word; `{final: true}` ends the stream with
 *   `transcription.done` and the whole text.
 * - OpenAI: a transcription session; every item comes as `input_audio_buffer.committed`, deltas
 *   and `conversation.item.input_audio_transcription.completed`; a commit ends the current item,
 *   or answers `input_audio_buffer_commit_empty` without audio since the last.
 *
 * Any bearer works, unless `TRANSCRIPTION_MOCK_REALTIME_KEY` is set: then another one gets 401 at
 * the handshake and at the model list. A model whose id contains `denied` is refused with 403 at
 * the handshake and missing from the model list, as the HRZ gateway refuses a model the key may
 * not use; one with `refused` gets an `error` event and a close after `session.update`; one with
 * `leak` repeats the bearer in an `error` event (the server must not pass it on).
 */

/** Seconds of received audio per sentence. */
export const ITEM_SECONDS = 3
/** Pause between two deltas. */
const DELTA_MS = 80
/** A stream without any message for this long is closed. */
const IDLE_MS = 120_000

const RATES = { onprem: 16_000, openai: 24_000 }

/** The script, one sentence per item, then from the start again. */
export const SCRIPT = [
  'Guten Morgen und willkommen zur Live-Transkription.',
  'Dies ist ein Test des lokalen Mocks.',
  'Jede dritte Sekunde Audio ergibt einen Satz.',
  'Die Wörter kommen einzeln an, der Satz zum Schluss vollständig.',
  'Beim Beenden wird der letzte Abschnitt abgeschlossen.'
]

/** The deltas of a sentence: its first word, then each further word with its leading space. */
export function sentenceDeltas(sentence) {
  return sentence.split(' ').map((word, index) => (index === 0 ? word : ` ${word}`))
}

/** The models each mock lists. */
const MODELS = {
  onprem: ['voxtral-mini-realtime', 'mock-realtime-refused', 'mock-realtime-leak'],
  openai: ['gpt-realtime-whisper', 'gpt-4o-transcribe']
}

const sockets = new WebSocketServer({ noServer: true })

function modeOf(path) {
  if (path === '/v1/realtime') return 'onprem'
  if (path === '/openai/v1/realtime') return 'openai'
  return null
}

function bearerOf(request) {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? '')
  return match ? match[1].trim() : null
}

function keyAccepted(request) {
  const key = process.env.TRANSCRIPTION_MOCK_REALTIME_KEY
  return !key || bearerOf(request) === key
}

/**
 * The model lists, the only HTTP endpoints below `/realtime`.
 *
 * @returns {Promise<boolean>} whether the request was handled
 */
export async function handle(request, response, path) {
  const mode = path === '/v1/models' ? 'onprem' : path === '/openai/v1/models' ? 'openai' : null
  if (request.method !== 'GET' || !mode) return false
  if (!keyAccepted(request)) {
    sendJson(response, 401, { error: { message: 'Invalid API key', type: 'auth_error' } })
    return true
  }
  sendJson(response, 200, { object: 'list', data: MODELS[mode].map((id) => ({ id })) })
  return true
}

/** Refuses an upgrade with an HTTP status, as a gateway does. */
function refuse(socket, status, text) {
  socket.end(
    `HTTP/1.1 ${status} ${text}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n` +
      JSON.stringify({ error: { message: text } })
  )
}

/**
 * A WebSocket upgrade below `/realtime`; returns whether it was one of the mock's.
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:stream').Duplex} socket
 * @param {Buffer} head
 * @param {string} path the path below `/realtime`
 */
export function upgrade(request, socket, head, path) {
  const mode = modeOf(path)
  if (!mode) return false
  const url = new URL(request.url ?? '/', 'http://mock')
  const model = url.searchParams.get('model') ?? ''
  if (!keyAccepted(request)) {
    refuse(socket, 401, 'Unauthorized')
    return true
  }
  if (model.includes('denied')) {
    refuse(socket, 403, 'Forbidden')
    return true
  }
  sockets.handleUpgrade(request, socket, head, (ws) => {
    new MockStream(ws, mode, bearerOf(request) ?? '')
  })
  return true
}

/** One gateway stream: counts its audio and sends the script. */
class MockStream {
  constructor(ws, mode, key) {
    this.ws = ws
    this.mode = mode
    this.key = key
    this.model = null
    this.audio = 0
    this.sentence = 0
    this.item = 0
    this.decoding = false
    this.text = ''
    this.sending = Promise.resolve()
    this.lastMessage = Date.now()
    ws.on('message', (data, binary) => {
      if (!binary) this.receive(data.toString())
    })
    ws.on('error', () => ws.terminate())
    this.timer = setInterval(() => {
      if (Date.now() - this.lastMessage > IDLE_MS) ws.close(1000)
    }, 5000)
    this.timer.unref?.()
    ws.on('close', () => clearInterval(this.timer))
    if (mode === 'openai')
      this.send({ type: 'session.created', session: { type: 'transcription' } })
  }

  get itemBytes() {
    return RATES[this.mode] * 2 * ITEM_SECONDS
  }

  receive(text) {
    this.lastMessage = Date.now()
    let event
    try {
      event = JSON.parse(text)
    } catch {
      return
    }
    switch (event?.type) {
      case 'session.update':
        this.sessionUpdate(event)
        return
      case 'input_audio_buffer.append':
        this.append(Buffer.from(String(event.audio ?? ''), 'base64').length)
        return
      case 'input_audio_buffer.commit':
        if (this.mode === 'onprem') this.vllmCommit(event.final === true)
        else this.openaiCommit()
        return
      default:
        return
    }
  }

  sessionUpdate(event) {
    this.model =
      this.mode === 'onprem' ? event.model : event.session?.audio?.input?.transcription?.model
    if (typeof this.model !== 'string') this.model = ''
    if (this.model.includes('refused')) {
      this.send({ type: 'error', error: { message: 'model not served', code: 'model_not_found' } })
      this.ws.close(1008, 'model not served')
      return
    }
    if (this.model.includes('leak')) {
      this.send({
        type: 'error',
        error: { message: `invalid credentials: Bearer ${this.key}`, code: this.key }
      })
      return
    }
    this.send({ type: 'session.updated' })
  }

  append(bytes) {
    this.audio += bytes
    if (this.mode === 'onprem' && !this.decoding) return
    while (this.audio >= this.itemBytes) {
      this.audio -= this.itemBytes
      this.queueSentence()
    }
  }

  vllmCommit(final) {
    if (!final) {
      this.decoding = true
      this.append(0)
      return
    }
    if (this.audio > 0) this.queueSentence()
    this.audio = 0
    this.sending = this.sending.then(() =>
      this.send({ type: 'transcription.done', text: this.text })
    )
  }

  openaiCommit() {
    if (this.audio < RATES.openai * 2 * 0.1) {
      this.send({
        type: 'error',
        error: { type: 'invalid_request_error', code: 'input_audio_buffer_commit_empty' }
      })
      return
    }
    this.audio = 0
    this.queueSentence()
  }

  /** The next sentence, after those already on their way. */
  queueSentence() {
    const sentence = SCRIPT[this.sentence % SCRIPT.length]
    this.sentence += 1
    const itemId = `item_mock_${++this.item}`
    this.sending = this.sending.then(() => this.sendSentence(itemId, sentence)).catch(() => {})
  }

  async sendSentence(itemId, sentence) {
    if (this.mode === 'openai') this.send({ type: 'input_audio_buffer.committed', item_id: itemId })
    const deltas = sentenceDeltas(sentence)
    // vLLM streams one text per stream: a further sentence starts with its space.
    if (this.mode === 'onprem' && this.text) deltas[0] = ` ${deltas[0]}`
    for (const delta of deltas) {
      this.send(
        this.mode === 'onprem'
          ? { type: 'transcription.delta', delta }
          : { type: 'conversation.item.input_audio_transcription.delta', item_id: itemId, delta }
      )
      await new Promise((resolve) => setTimeout(resolve, DELTA_MS))
    }
    if (this.mode === 'onprem') {
      this.text += deltas.join('')
      return
    }
    this.send({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: itemId,
      transcript: sentence
    })
  }

  send(event) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(event))
  }
}

/** Closes every stream, e.g. when the mock stops. */
export function closeStreams() {
  for (const ws of sockets.clients) ws.terminate()
}
