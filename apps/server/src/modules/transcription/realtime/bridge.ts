import { createHash } from 'node:crypto'

import type {
  TranscriptionComponentConfig,
  TranscriptionOnpremUnavailableReason
} from '@justcampus/shared'
import { z } from 'zod'

import { reachedThroughProxy } from '../../../env.js'
import { onpremGatewayUrl, type TranscriptionSecrets } from '../config.js'
import {
  bearer,
  listModels,
  rememberKey,
  secretsOfResponse,
  upstreamFetch,
  UpstreamError
} from '../http.js'
import { parseSignalingAnswer, REALTIME_TIMEOUT_MS } from './upstream.js'

/**
 * The on-prem live path (T-60), as kiChat's `RealtimeSignalingController::createOnPremSignaling`:
 * the browser's SDP offer goes through this server to the realtime bridge
 * (`infra/realtime-bridge`), which answers with its own SDP and streams the audio to the
 * gateway's realtime WebSocket (`{gateway}/v1/realtime?model=…`). The gateway's base, key and
 * model travel per request as `X-Gateway-Base`, `X-Gateway-Key` and `X-Model`, so the bridge
 * stores no gateway credentials, and neither the key nor the bridge's address reach the browser.
 * The bridge's own `BRIDGE_API_KEY` goes as bearer (`TRANSCRIPTION_REALTIME_BRIDGE_KEY`).
 */

/** Where the bridge is and what it streams to, for one request. */
export interface OnpremTarget {
  /** The bridge's address, from `onpremSignalingUrl`. */
  bridgeUrl: string
  /** The gateway up to `/v1`, for its model list. */
  gatewayUrl: string
  /** The gateway without `/v1`, as the bridge takes it (`X-Gateway-Base`). */
  gatewayBase: string
  /** The speech key, which is the gateway's. */
  gatewayKey: string | null
  model: string
  /** The bridge's `BRIDGE_API_KEY`, if it has one. */
  bridgeKey: string | null
}

/**
 * The on-prem target of the saved settings, with what the admin form typed instead where given;
 * `null` without a bridge or a gateway.
 */
export function onpremTarget(
  config: TranscriptionComponentConfig,
  secrets: Pick<TranscriptionSecrets, 'apiKey'>,
  bridgeKey: string | undefined,
  typed: {
    bridgeUrl?: string
    gatewayUrl?: string | null
    apiKey?: string | null
    model?: string
  } = {}
): OnpremTarget | null {
  const bridgeUrl = typed.bridgeUrl ?? config.onpremSignalingUrl
  const gatewayUrl = onpremGatewayUrl({
    asrBaseUrl: config.asrBaseUrl,
    onpremGatewayUrl: typed.gatewayUrl === undefined ? config.onpremGatewayUrl : typed.gatewayUrl
  })
  if (!bridgeUrl || !gatewayUrl) return null
  return {
    bridgeUrl,
    gatewayUrl,
    gatewayBase: gatewayBaseOf(gatewayUrl),
    gatewayKey: typed.apiKey === undefined ? secrets.apiKey : typed.apiKey,
    model: typed.model ?? config.onpremRealtimeModel,
    bridgeKey: bridgeKey ?? null
  }
}

/** A gateway up to `/v1` without it; the bridge appends `/v1/realtime` itself. */
export function gatewayBaseOf(gatewayUrl: string): string {
  return gatewayUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
}

/**
 * The bridge's endpoints below its address: `POST /realtime` (signaling), `POST /probe` and
 * `GET /health`. An address that already ends in `/realtime` is taken as the signaling endpoint.
 */
export function bridgeEndpoints(bridgeUrl: string): {
  signaling: string
  probe: string
  health: string
} {
  const url = new URL(bridgeUrl)
  const path = url.pathname.replace(/\/+$/, '').replace(/\/realtime$/, '')
  const base = `${url.origin}${path}`
  return { signaling: `${base}/realtime`, probe: `${base}/probe`, health: `${base}/health` }
}

/**
 * The headers of every request to the bridge, as kiChat's controller sends them. The gateway key
 * is noted for `maskSecrets`, as `bearer` notes the bridge key: the bridge's errors may reflect it.
 */
export function bridgeHeaders(target: OnpremTarget): Record<string, string> {
  rememberKey(target.gatewayKey)
  return {
    'X-Gateway-Base': target.gatewayBase,
    'X-Gateway-Key': target.gatewayKey ?? '',
    'X-Model': target.model,
    ...bearer(target.bridgeKey)
  }
}

/** Why the on-prem path failed, from the bridge's or the gateway's answer. */
export class OnpremUnavailable extends UpstreamError {
  constructor(
    readonly reason: TranscriptionOnpremUnavailableReason,
    readonly model: string,
    status: number | null,
    detail: string | null = null,
    secrets: readonly (string | null | undefined)[] = []
  ) {
    super(unavailableMessage(reason, model), status, detail, false, secrets)
    this.name = 'OnpremUnavailable'
  }
}

/** What the server says when the on-prem path cannot run; the web app words it in its language. */
export function unavailableMessage(
  reason: TranscriptionOnpremUnavailableReason,
  model: string
): string {
  switch (reason) {
    case 'modelNotAllowed':
      return `The gateway does not allow the realtime model ${model} for this API key`
    case 'gatewayKeyRejected':
      return 'The gateway refused the API key'
    case 'gatewayRefused':
      return `The gateway refused a realtime session with ${model}`
    case 'gatewayUnreachable':
      return 'The realtime bridge cannot reach the gateway'
    case 'bridgeUnreachable':
      return 'The realtime bridge is unreachable'
    case 'bridgeKeyRejected':
      return 'The realtime bridge refused the server (TRANSCRIPTION_REALTIME_BRIDGE_KEY)'
    case 'bridgeBusy':
      return 'The realtime bridge takes no more sessions right now'
  }
}

/** The bridge's error answer (`error_response` in `bridge.py`). */
const bridgeErrorSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
  upstream_status: z.number().int().optional()
})

/**
 * Why a failed bridge answer failed. A refused offer (400) is the offer's fault and leaves the
 * path available. A gateway that refused the handshake with 401 or 403 is asked for its model list
 * with the same key, which tells a refused key (the list fails too) from a key that may not use
 * the model (the list works and lacks it).
 */
export async function failureOf(
  response: Response,
  target: OnpremTarget,
  signal?: AbortSignal
): Promise<UpstreamError> {
  const text = await response.text().catch(() => '')
  // The whole answer: the error masks the request's keys in it before cutting it short.
  const detail = text || null
  const secrets = [...secretsOfResponse(response), target.gatewayKey, target.bridgeKey]
  const fail = (reason: TranscriptionOnpremUnavailableReason): OnpremUnavailable =>
    new OnpremUnavailable(reason, target.model, response.status, detail, secrets)
  if (response.status === 400) {
    return new UpstreamError('The realtime bridge refused the offer', 400, detail, false, secrets)
  }
  if (response.status === 401) return fail('bridgeKeyRejected')
  let body: z.infer<typeof bridgeErrorSchema> | null = null
  try {
    const parsed = bridgeErrorSchema.safeParse(JSON.parse(text))
    if (parsed.success) body = parsed.data
  } catch {
    body = null
  }
  if (!body) return fail('bridgeUnreachable')
  if (body.error === 'busy') return fail('bridgeBusy')
  if (body.error === 'upstream_failed') return fail('gatewayUnreachable')
  const refusedAuth =
    body.error === 'upstream_rejected' &&
    (body.upstream_status === 401 || body.upstream_status === 403)
  if (!refusedAuth) return fail('gatewayRefused')
  return fail(await refusalReason(target, signal))
}

/** A refused handshake: the key, or the model for this key (see `failureOf`). */
async function refusalReason(
  target: OnpremTarget,
  signal?: AbortSignal
): Promise<TranscriptionOnpremUnavailableReason> {
  try {
    const models = await listModels(target.gatewayUrl, target.gatewayKey, signal)
    return models.some((model) => model.id === target.model) ? 'gatewayRefused' : 'modelNotAllowed'
  } catch (error) {
    if (signal?.aborted) throw error
    if (error instanceof UpstreamError && (error.status === 401 || error.status === 403)) {
      return 'gatewayKeyRejected'
    }
    return 'gatewayRefused'
  }
}

/** Bridge hosts already warned about (`warnIfProxied`). */
const proxiedBridges = new Set<string>()

/**
 * Warns once per host when requests to the bridge would go through the outbound proxy: they carry
 * the gateway key and the bridge key in plain HTTP, and the proxy usually cannot reach the host
 * anyway. The bridge belongs into `NO_PROXY` (`host.docker.internal` in production). Returns
 * whether it would.
 */
export function warnIfProxied(
  bridgeUrl: string,
  environment: NodeJS.ProcessEnv = process.env,
  execArgv: readonly string[] = process.execArgv
): boolean {
  if (!reachedThroughProxy(environment, bridgeUrl, execArgv)) return false
  const host = new URL(bridgeUrl).host
  if (!proxiedBridges.has(host)) {
    proxiedBridges.add(host)
    console.warn(
      `Outbound proxy: the realtime bridge ${host} would be reached through the proxy: add it to NO_PROXY.`
    )
  }
  return true
}

/** A request to the bridge; an unreachable bridge is `bridgeUnreachable`. */
async function bridgeFetch(
  url: string,
  init: RequestInit & { timeoutMs: number; signal?: AbortSignal },
  target: OnpremTarget
): Promise<Response> {
  warnIfProxied(url)
  try {
    return await upstreamFetch(url, init)
  } catch (error) {
    if (init.signal?.aborted) throw error
    const detail = error instanceof UpstreamError ? error.message : null
    throw new OnpremUnavailable('bridgeUnreachable', target.model, null, detail, [
      target.gatewayKey,
      target.bridgeKey
    ])
  }
}

/**
 * Sends the browser's SDP offer to the bridge and returns its answer. The bridge connects to the
 * gateway before it answers, so a refused key or model fails here, as `OnpremUnavailable`.
 */
export async function onpremSignaling(
  target: OnpremTarget,
  offer: string,
  signal?: AbortSignal
): Promise<string> {
  const response = await bridgeFetch(
    bridgeEndpoints(target.bridgeUrl).signaling,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/sdp',
        Accept: 'application/sdp',
        ...bridgeHeaders(target)
      },
      body: offer,
      timeoutMs: REALTIME_TIMEOUT_MS,
      signal
    },
    target
  )
  if (!response.ok) throw await failureOf(response, target, signal)
  return parseSignalingAnswer(await response.text(), response.headers.get('content-type'), offer)
}

/**
 * Whether the gateway takes the key and model, through the bridge's `POST /probe`: one realtime
 * stream opened, the model validated, closed again, without audio or WebRTC.
 */
export async function probeOnprem(
  target: OnpremTarget,
  signal?: AbortSignal,
  timeoutMs = REALTIME_TIMEOUT_MS
): Promise<number> {
  const response = await bridgeFetch(
    bridgeEndpoints(target.bridgeUrl).probe,
    { method: 'POST', headers: bridgeHeaders(target), timeoutMs, signal },
    target
  )
  if (!response.ok) throw await failureOf(response, target, signal)
  await response.body?.cancel()
  return response.status
}

/** How long a probe's finding holds: a working path for a while, a failure only briefly. */
export const AVAILABLE_TTL_MS = 5 * 60_000
export const UNAVAILABLE_TTL_MS = 30_000
/** The live tab's config waits this long for a probe. */
const CONFIG_PROBE_TIMEOUT_MS = 5000

type Availability = { reason: TranscriptionOnpremUnavailableReason; model: string } | null

const availability = new Map<string, { expires: number; value: Promise<Availability> }>()

/** One target's cache entry; keys only as a digest. */
function cacheKey(target: OnpremTarget): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        target.bridgeUrl,
        target.gatewayBase,
        target.model,
        target.gatewayKey,
        target.bridgeKey
      ])
    )
    .digest('hex')
}

/** Notes what a session or probe found, so the live tab's config shows it. */
export function rememberAvailability(
  target: OnpremTarget,
  value: Availability,
  now = Date.now()
): void {
  availability.set(cacheKey(target), {
    expires: now + (value ? UNAVAILABLE_TTL_MS : AVAILABLE_TTL_MS),
    value: Promise.resolve(value)
  })
}

/** Forgets every finding (tests). */
export function forgetAvailability(): void {
  availability.clear()
}

/**
 * Why the on-prem path cannot run right now, or `null` while it can, from a cached probe. A probe
 * that fails without a reason (the bridge timed out, say) counts as `bridgeUnreachable`.
 */
export function onpremAvailability(target: OnpremTarget, now = Date.now()): Promise<Availability> {
  const key = cacheKey(target)
  const cached = availability.get(key)
  if (cached && cached.expires > now) return cached.value
  const value = probeOnprem(target, undefined, CONFIG_PROBE_TIMEOUT_MS).then(
    (): Availability => null,
    (error: unknown): Availability => {
      const reason = error instanceof OnpremUnavailable ? error.reason : 'bridgeUnreachable'
      console.error(
        `Transcription realtime probe failed: ${unavailableMessage(reason, target.model)}`
      )
      return { reason, model: target.model }
    }
  )
  availability.set(key, { expires: now + UNAVAILABLE_TTL_MS, value })
  void value.then((found) => {
    const entry = availability.get(key)
    if (entry?.value === value) {
      entry.expires = now + (found ? UNAVAILABLE_TTL_MS : AVAILABLE_TTL_MS)
    }
  })
  return value
}
