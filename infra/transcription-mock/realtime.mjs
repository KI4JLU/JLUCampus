import { readBody, sendJson, sendText } from './http.mjs'
import { answerWithPeer, OfferRefused } from './realtime-peer.mjs'

/**
 * Live transcription, below `/realtime`: the on-prem realtime bridge (`infra/realtime-bridge`)
 * below `/bridge` with its protocol, and OpenAI Realtime below `/openai/v1`:
 * `POST /realtime/client_secrets` (ephemeral key) and `POST /realtime/calls` (SDP with that key).
 *
 * The bridge's `POST /realtime` takes the SDP offer as `application/sdp` with the gateway headers
 * the Campus server sends (`X-Gateway-Base`, `X-Model`, `X-Gateway-Key`) and answers with SDP;
 * `POST /probe` checks the same headers, `GET /health` answers `ok`. A model whose id contains
 * `denied` is refused as the gateway refuses a model the key may not use: `502` with
 * `upstream_status: 403`. With `TRANSCRIPTION_MOCK_BRIDGE_KEY` set, the bridge wants it as bearer.
 *
 * Both modes answer with a real WebRTC peer (`realtime-peer.mjs`, on werift) that receives the
 * audio and sends a deterministic transcript over the `oai-events` data channel, so either live
 * mode can be tried end to end. An offer the peer cannot negotiate is refused with 400, as by the
 * bridge. Only without werift does an offer get a well-formed stub answer derived from it, with
 * which no media or data channel connects. Ephemeral keys are `ek_mock_<n>` and work for
 * `/realtime/calls` only; any other bearer there answers 401.
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {string} path the path below `/realtime`, e.g. `/bridge/realtime`
 * @returns {Promise<boolean>} whether the request was handled
 */
export async function handle(request, response, path) {
  if (path.startsWith('/bridge/')) return handleBridge(request, response, path.slice(7))
  if (request.method !== 'POST') return false
  if (path === '/openai/v1/realtime/client_secrets') {
    if (!bearerOf(request)) {
      sendJson(response, 401, {
        error: { message: 'Missing bearer token', type: 'invalid_request_error' }
      })
      return true
    }
    await readBody(request)
    issued += 1
    const value = `ek_mock_${issued}`
    keys.add(value)
    sendJson(response, 200, {
      value,
      expires_at: Math.floor(Date.now() / 1000) + 600,
      session: { type: 'transcription', object: 'realtime.transcription_session' }
    })
    return true
  }
  if (path === '/openai/v1/realtime/calls') {
    if (!keys.has(bearerOf(request) ?? '')) {
      sendJson(response, 401, {
        error: { message: 'Invalid ephemeral key', type: 'invalid_request_error' }
      })
      return true
    }
    const offer = (await readBody(request)).toString('utf8')
    if (!isSdp(offer)) {
      sendJson(response, 400, { error: { message: 'Expected an SDP offer' } })
      return true
    }
    const answer = await answerOrRefusal(offer)
    if (answer.refused) {
      sendJson(response, 400, { error: { message: answer.refused } })
      return true
    }
    response.setHeader('Location', `/v1/realtime/calls/rtc_mock_${issued}`)
    sendText(response, 201, answer.sdp, 'application/sdp')
    return true
  }
  return false
}

/**
 * The bridge's API (`bridge.py`): errors as `{ error, message, upstream_status? }`.
 *
 * @returns {Promise<boolean>}
 */
async function handleBridge(request, response, path) {
  if (request.method === 'GET' && path === '/health') {
    sendText(response, 200, 'ok')
    return true
  }
  if (request.method !== 'POST' || (path !== '/realtime' && path !== '/probe')) return false
  const key = process.env.TRANSCRIPTION_MOCK_BRIDGE_KEY
  if (key && request.headers.authorization !== `Bearer ${key}`) {
    await readBody(request)
    sendJson(response, 401, { error: 'unauthorized', message: 'missing or wrong bridge API key' })
    return true
  }
  const base = String(request.headers['x-gateway-base'] ?? '').trim()
  const model = String(request.headers['x-model'] ?? '').trim()
  const body = (await readBody(request)).toString('utf8')
  if (!base || !model) {
    sendJson(response, 400, {
      error: 'bad_request',
      message: 'X-Gateway-Base and X-Model are required'
    })
    return true
  }
  if (model.includes('denied')) {
    sendJson(response, 502, {
      error: 'upstream_rejected',
      message: 'the gateway refused the realtime connection with status 403',
      upstream_status: 403,
      model
    })
    return true
  }
  if (path === '/probe') {
    sendJson(response, 200, { ok: true, model })
    return true
  }
  if (!body.startsWith('v=')) {
    sendJson(response, 400, { error: 'bad_request', message: 'body must be an SDP offer' })
    return true
  }
  const answer = await answerOrRefusal(body)
  if (answer.refused) sendJson(response, 400, { error: 'bad_offer', message: answer.refused })
  else sendText(response, 200, answer.sdp, 'application/sdp')
  return true
}

/**
 * The peer's answer to an offer, the stub's without werift, or why the offer is refused.
 *
 * @param {string} offer
 * @returns {Promise<{ sdp: string, refused?: undefined } | { refused: string }>}
 */
async function answerOrRefusal(offer) {
  try {
    return { sdp: (await answerWithPeer(offer)) ?? answerSdp(offer) }
  } catch (error) {
    if (error instanceof OfferRefused) return { refused: error.message }
    throw error
  }
}

let issued = 0
/** Ephemeral keys handed out by this process. */
const keys = new Set()

function bearerOf(request) {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? '')
  return match ? match[1].trim() : null
}

function isSdp(text) {
  return /^v=0\r?\n/.test(text.trimStart())
}

/**
 * An answer to an offer: its media sections in order with their `mid`s, receiving where the offer
 * sends, with fixed ICE credentials and fingerprint.
 */
export function answerSdp(offer) {
  const lines = offer.split(/\r?\n/)
  const sections = []
  for (const line of lines) {
    if (line.startsWith('m=')) sections.push({ media: line, attributes: [] })
    else if (sections.length > 0) sections.at(-1).attributes.push(line)
  }
  const mids = sections.map(
    (section, index) =>
      section.attributes.find((line) => line.startsWith('a=mid:'))?.slice(6) ?? String(index)
  )
  const answer = [
    'v=0',
    'o=mock-bridge 1 1 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    `a=group:BUNDLE ${mids.join(' ')}`
  ]
  sections.forEach((section, index) => {
    const direction = section.attributes.some(
      (line) => line === 'a=sendonly' || line === 'a=sendrecv'
    )
      ? 'a=recvonly'
      : 'a=inactive'
    answer.push(
      section.media.replace(/^(m=\w+) \d+/, '$1 9'),
      'c=IN IP4 0.0.0.0',
      `a=mid:${mids[index]}`,
      'a=ice-ufrag:mock',
      'a=ice-pwd:mockmockmockmockmockmock',
      'a=fingerprint:sha-256 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF',
      'a=setup:passive',
      ...section.attributes.filter((line) => /^a=(rtpmap|fmtp|max-message-size):/.test(line)),
      section.media.startsWith('m=application') ? 'a=sctp-port:5000' : direction
    )
  })
  return `${answer.join('\r\n')}\r\n`
}
