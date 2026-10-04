import { readBody, sendJson, sendText } from './http.mjs'
import { answerWithPeer, OfferRefused } from './realtime-peer.mjs'

/**
 * Live transcription, below `/realtime`: the on-prem bridge's `POST /onprem/signaling` (SDP offer
 * in, SDP answer out) and OpenAI Realtime below `/openai/v1`: `POST /realtime/client_secrets`
 * (ephemeral key) and `POST /realtime/calls` (SDP with that key).
 *
 * Both answer with a real WebRTC peer (`realtime-peer.mjs`, on werift) that receives the audio and
 * sends a deterministic transcript over the `oai-events` data channel, so either live mode can be
 * tried end to end. An offer the peer cannot negotiate is refused with 400, as by a real bridge.
 * Only without werift does an offer get a well-formed stub answer derived from it, with which no
 * media or data channel connects. Ephemeral keys are `ek_mock_<n>` and work for `/realtime/calls`
 * only; any other bearer there answers 401.
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {string} path the path below `/realtime`, e.g. `/onprem/signaling`
 * @returns {Promise<boolean>} whether the request was handled
 */
export async function handle(request, response, path) {
  if (request.method !== 'POST') return false
  if (path === '/onprem/signaling') {
    const offer = await offerOf(request)
    if (!offer) {
      sendJson(response, 400, { error: 'Expected an SDP offer' })
      return true
    }
    const answer = await answerOrRefusal(offer)
    if (answer.refused) sendJson(response, 400, { error: answer.refused })
    else sendJson(response, 200, { type: 'answer', sdp: answer.sdp })
    return true
  }
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

/** The offer of a request: JSON `{sdp}` or the SDP itself. */
async function offerOf(request) {
  const text = (await readBody(request)).toString('utf8')
  if (isSdp(text)) return text
  try {
    const sdp = JSON.parse(text)?.sdp
    return typeof sdp === 'string' && isSdp(sdp) ? sdp : null
  } catch {
    return null
  }
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
