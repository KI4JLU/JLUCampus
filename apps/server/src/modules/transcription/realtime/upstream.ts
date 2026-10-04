import { z } from 'zod'

import { bearer, ensureOk, upstreamFetch, UpstreamError } from '../http.js'
import { sdpAnswerProblem } from './sdp.js'

/**
 * The two live transcription upstreams (T-59, T-60): the on-prem bridge, which takes the
 * browser's SDP offer and answers with its own, and OpenAI Realtime, which issues ephemeral keys
 * for the browser's own WebRTC call. Neither ever sees a key of the browser's.
 */

/** Signaling and key requests are quick; the browser waits 15 s for the whole connection. */
export const REALTIME_TIMEOUT_MS = 15_000

/** The longest SDP answer passed on. */
const SDP_MAX = 100_000

/** Whether a text looks like an SDP session description. */
export function isSdp(text: string): boolean {
  return /^v=0\r?\n/.test(text.trimStart())
}

const signalingAnswerSchema = z.object({
  sdp: z.string().optional(),
  answer: z.union([z.string(), z.object({ sdp: z.string() })]).optional()
})

/**
 * The bridge's SDP answer from its response: JSON `{sdp}` (or `{answer}`), or the SDP itself as
 * `application/sdp` or text. It must be one a WebRTC peer can use (`sdpAnswerProblem`), for
 * `offer` if given.
 */
export function parseSignalingAnswer(
  body: string,
  contentType: string | null,
  offer: string | null = null
): string {
  let sdp: string | undefined
  if (contentType?.includes('json') || body.trimStart().startsWith('{')) {
    let json: unknown
    try {
      json = JSON.parse(body)
    } catch {
      json = undefined
    }
    const parsed = signalingAnswerSchema.safeParse(json)
    if (parsed.success) {
      const { answer } = parsed.data
      sdp = parsed.data.sdp ?? (typeof answer === 'string' ? answer : answer?.sdp)
    }
  } else {
    sdp = body
  }
  if (!sdp || !isSdp(sdp) || sdp.length > SDP_MAX) {
    throw new UpstreamError('The signaling bridge answered without an SDP answer', 200)
  }
  const problem = sdpAnswerProblem(sdp.trimStart(), offer)
  if (problem) {
    throw new UpstreamError(`The signaling bridge answered with an unusable SDP: ${problem}`, 200)
  }
  return sdp
}

/** Sends the browser's SDP offer to the on-prem bridge and returns its answer. */
export async function onpremSignaling(
  url: string,
  offer: string,
  signal?: AbortSignal
): Promise<string> {
  const response = await ensureOk(
    await upstreamFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, application/sdp' },
      body: JSON.stringify({ sdp: offer, type: 'offer' }),
      timeoutMs: REALTIME_TIMEOUT_MS,
      signal
    }),
    'The signaling bridge'
  )
  return parseSignalingAnswer(await response.text(), response.headers.get('content-type'), offer)
}

/** How long an ephemeral key lasts: long enough to connect, not more. */
export const EPHEMERAL_KEY_SECONDS = 600

/** OpenAI's `POST /realtime/client_secrets` for a transcription session with `model`. */
export function clientSecretRequest(model: string): unknown {
  return {
    expires_after: { anchor: 'created_at', seconds: EPHEMERAL_KEY_SECONDS },
    session: { type: 'transcription', audio: { input: { transcription: { model } } } }
  }
}

const clientSecretSchema = z.union([
  z.object({ value: z.string().min(1), expires_at: z.number().nullable().optional() }),
  // The older answer shape of `/realtime/sessions`.
  z
    .object({
      client_secret: z.object({
        value: z.string().min(1),
        expires_at: z.number().nullable().optional()
      })
    })
    .transform((body) => body.client_secret)
])

/**
 * An ephemeral key from OpenAI's answer, with its expiry (seconds since the epoch). One that has
 * already expired at `now` is no key.
 */
export function parseClientSecret(
  body: unknown,
  now: Date = new Date()
): { value: string; expiresAt: string | null } {
  const parsed = clientSecretSchema.safeParse(body)
  if (!parsed.success) {
    throw new UpstreamError('OpenAI answered without an ephemeral key', 200)
  }
  const expires = parsed.data.expires_at
  if (typeof expires === 'number' && expires * 1000 <= now.getTime()) {
    throw new UpstreamError('OpenAI answered with an ephemeral key that has expired', 200)
  }
  return {
    value: parsed.data.value,
    expiresAt: typeof expires === 'number' ? new Date(expires * 1000).toISOString() : null
  }
}

/** Asks OpenAI for an ephemeral key with the admin's long-lived one. */
export async function issueClientSecret(
  clientSecretsUrl: string,
  apiKey: string,
  model: string,
  signal?: AbortSignal
): Promise<{ value: string; expiresAt: string | null }> {
  const response = await ensureOk(
    await upstreamFetch(clientSecretsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...bearer(apiKey)
      },
      body: JSON.stringify(clientSecretRequest(model)),
      timeoutMs: REALTIME_TIMEOUT_MS,
      signal
    }),
    'OpenAI Realtime'
  )
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new UpstreamError('OpenAI Realtime did not answer with JSON', response.status)
  }
  return parseClientSecret(body)
}
