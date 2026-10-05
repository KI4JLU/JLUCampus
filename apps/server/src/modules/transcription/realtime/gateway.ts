import { createHash } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'

import type {
  TranscriptionComponentConfig,
  TranscriptionRealtimeMode,
  TranscriptionRealtimeUnavailableReason
} from '@justcampus/shared'
import WebSocket, { type RawData } from 'ws'

import { proxyVariable, reachedThroughProxy } from '../../../env.js'
import { onpremGatewayUrl, type TranscriptionSecrets } from '../config.js'
import { listModels, rememberKey, UpstreamError } from '../http.js'
import { readUpstreamEvent, realtimeSocketUrl, sessionUpdate } from './protocol.js'

/**
 * The server's side of live transcription towards the gateway (T-59, T-60): where a mode's
 * realtime WebSocket is, opening it with the key in the `Authorization` header (through the
 * outbound proxy where Node's `fetch` would use one), and why a gateway refused. The key stays
 * on this server; nothing a gateway says reaches a log or the browser: errors carry the server's
 * own words, the gateway's status and close code at most.
 */

/** Where one mode's live sessions go. */
export interface RealtimeTarget {
  mode: TranscriptionRealtimeMode
  /** The gateway's API up to `/v1`, for its model list. */
  apiBase: string
  /** Its realtime WebSocket (`realtimeSocketUrl`). */
  url: string
  apiKey: string | null
  model: string
}

/**
 * The target of a mode from the saved settings, with what the admin form typed instead where
 * given; `null` while the mode lacks its gateway (on-prem) or key (OpenAI).
 */
export function realtimeTarget(
  mode: TranscriptionRealtimeMode,
  config: TranscriptionComponentConfig,
  secrets: Pick<TranscriptionSecrets, 'apiKey' | 'openaiRealtimeApiKey'>,
  typed: { url?: string | null; apiKey?: string | null; model?: string } = {}
): RealtimeTarget | null {
  if (mode === 'onprem') {
    const apiBase = onpremGatewayUrl({
      asrBaseUrl: config.asrBaseUrl,
      onpremGatewayUrl: typed.url === undefined ? config.onpremGatewayUrl : typed.url
    })
    if (!apiBase) return null
    const model = typed.model ?? config.onpremRealtimeModel
    const apiKey = typed.apiKey === undefined ? secrets.apiKey : typed.apiKey
    return { mode, apiBase, url: realtimeSocketUrl(mode, apiBase, model), apiKey, model }
  }
  const apiKey = typed.apiKey === undefined ? secrets.openaiRealtimeApiKey : typed.apiKey
  if (!apiKey) return null
  const apiBase = typed.url ?? config.openaiRealtimeUrl
  const model = typed.model ?? config.openaiRealtimeModel
  return { mode, apiBase, url: realtimeSocketUrl(mode, apiBase, model), apiKey, model }
}

/** Opening a realtime stream: connection, upgrade answer and `session.update`. */
export const HANDSHAKE_TIMEOUT_MS = 10_000
/** The longest message taken from a gateway. */
const UPSTREAM_MESSAGE_MAX = 1024 * 1024

/** The gateway answered the WebSocket upgrade with an HTTP status: it refused the session. */
export class GatewayRefused extends Error {
  constructor(readonly status: number) {
    super(`The gateway refused the realtime connection with status ${status}`)
    this.name = 'GatewayRefused'
  }
}

/**
 * The gateway accepted the connection and then refused the session: an `error` event or a close
 * right after `session.update`, as vLLM refuses a model it does not serve.
 */
export class GatewaySessionRefused extends Error {
  constructor(readonly closeCode: number | null) {
    super(
      closeCode === null
        ? 'The gateway refused the realtime session'
        : `The gateway closed the realtime session with code ${closeCode}`
    )
    this.name = 'GatewaySessionRefused'
  }
}

/** The gateway (or the proxy before it) did not answer, or not in time. */
export class GatewayUnreachable extends Error {
  constructor(readonly timedOut: boolean) {
    super(
      timedOut
        ? `The gateway did not complete the realtime handshake within ${HANDSHAKE_TIMEOUT_MS / 1000} s`
        : 'The gateway is unreachable'
    )
    this.name = 'GatewayUnreachable'
  }
}

/** An exception as a log names it: the server's own by message, any other by class only. */
export function failureText(error: unknown): string {
  if (
    error instanceof GatewayRefused ||
    error instanceof GatewaySessionRefused ||
    error instanceof GatewayUnreachable
  ) {
    return error.message
  }
  return error instanceof Error ? error.name : typeof error
}

/** Thrown into a wait that the caller's signal ended. */
function aborted(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Aborted')
}

/**
 * A TCP tunnel to `host:port` through an HTTP proxy (`CONNECT`), as Node's `fetch` reaches the
 * internet behind one. Credentials in the proxy URL go as `Proxy-Authorization`.
 */
function proxyTunnel(proxy: URL, host: string, port: number, signal: AbortSignal): Promise<Socket> {
  return new Promise((resolve, reject) => {
    if (proxy.protocol !== 'http:') {
      reject(new GatewayUnreachable(false))
      return
    }
    const authority = `${host.includes(':') ? `[${host}]` : host}:${port}`
    const headers: Record<string, string> = { Host: authority }
    if (proxy.username) {
      const user = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`
      headers['Proxy-Authorization'] = `Basic ${Buffer.from(user).toString('base64')}`
    }
    const proxyPort = Number(proxy.port) || 80
    const proxyHost = proxy.hostname.replace(/^\[|\]$/g, '')
    const request = httpRequest({
      method: 'CONNECT',
      path: authority,
      headers,
      // Straight to the proxy, past any agent that would proxy this request again.
      createConnection: () => netConnect(proxyPort, proxyHost)
    })
    const onAbort = (): void => {
      request.destroy()
      reject(aborted(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    request.once('connect', (response, socket) => {
      signal.removeEventListener('abort', onAbort)
      if (response.statusCode === 200) {
        resolve(socket)
        return
      }
      socket.destroy()
      reject(new GatewayUnreachable(false))
    })
    request.once('error', () => {
      signal.removeEventListener('abort', onAbort)
      reject(signal.aborted ? aborted(signal) : new GatewayUnreachable(false))
    })
    request.end()
  })
}

/** The outbound proxy for `url` (a `ws:`/`wss:` URL), as Node's `fetch` would use it; else `null`. */
export function proxyFor(
  url: string,
  environment: NodeJS.ProcessEnv = process.env,
  execArgv: readonly string[] = process.execArgv
): URL | null {
  const http = url.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:')
  if (!reachedThroughProxy(environment, http, execArgv)) return null
  const proxy = proxyVariable(environment, http.startsWith('https:') ? 'HTTPS_PROXY' : 'HTTP_PROXY')
  try {
    return proxy ? new URL(proxy) : null
  } catch {
    return null
  }
}

/**
 * Opens a gateway's realtime WebSocket and sets its session up (`session.update`), within
 * `HANDSHAKE_TIMEOUT_MS` in all. An upgrade answered with an HTTP status throws `GatewayRefused`,
 * no answer or none in time `GatewayUnreachable`. A socket that does not get there is dropped.
 */
export async function openGateway(
  target: RealtimeTarget,
  signal: AbortSignal,
  timeoutMs = HANDSHAKE_TIMEOUT_MS
): Promise<WebSocket> {
  rememberKey(target.apiKey)
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
  const url = new URL(target.url)
  const secure = url.protocol === 'wss:'
  const proxy = proxyFor(target.url)
  let tunnel: Socket | null = null
  if (proxy) {
    const port = Number(url.port) || (secure ? 443 : 80)
    try {
      tunnel = await proxyTunnel(proxy, url.hostname.replace(/^\[|\]$/g, ''), port, deadline)
    } catch (error) {
      if (signal.aborted) throw aborted(signal)
      if (deadline.aborted) throw new GatewayUnreachable(true)
      throw error
    }
  }
  const socket = new WebSocket(target.url, {
    headers: target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {},
    handshakeTimeout: timeoutMs,
    maxPayload: UPSTREAM_MESSAGE_MAX,
    perMessageDeflate: false,
    followRedirects: false,
    ...(tunnel
      ? {
          createConnection: () =>
            secure
              ? tlsConnect({
                  socket: tunnel,
                  servername: url.hostname,
                  ALPNProtocols: ['http/1.1']
                })
              : tunnel
        }
      : {})
  })
  // ws reports a failed or dropped handshake as `error` too, also after `terminate()`: the
  // listener stays for the socket's life, so none goes unhandled.
  let onHandshakeError: (() => void) | null = null
  socket.on('error', () => {
    if (onHandshakeError) onHandshakeError()
    else socket.terminate()
  })
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const settle = (error?: Error): void => {
        if (settled) return
        settled = true
        onHandshakeError = null
        deadline.removeEventListener('abort', onDeadline)
        if (error) reject(error)
        else resolve()
      }
      const onDeadline = (): void =>
        settle(signal.aborted ? aborted(signal) : new GatewayUnreachable(true))
      deadline.addEventListener('abort', onDeadline, { once: true })
      onHandshakeError = () => settle(new GatewayUnreachable(false))
      socket.once('unexpected-response', (request, response) => {
        response.resume()
        settle(new GatewayRefused(response.statusCode ?? 0))
        request.destroy()
      })
      socket.once('open', () => {
        socket.send(JSON.stringify(sessionUpdate(target.mode, target.model)), (error) =>
          settle(error ? new GatewayUnreachable(false) : undefined)
        )
      })
    })
  } catch (error) {
    socket.terminate()
    tunnel?.destroy()
    throw error
  }
  return socket
}

/** How long a probe waits after `session.update` for the gateway to refuse the session. */
export const PROBE_WAIT_MS = 1500

/** Waits `waitMs` for the gateway to refuse the session just set up; `session.updated` ends it. */
function refusalOf(
  socket: WebSocket,
  mode: TranscriptionRealtimeMode,
  waitMs: number
): Promise<GatewaySessionRefused | null> {
  return new Promise<GatewaySessionRefused | null>((resolve) => {
    const finish = (value: GatewaySessionRefused | null): void => {
      clearTimeout(timer)
      socket.off('message', onMessage)
      socket.off('close', onClose)
      resolve(value)
    }
    const onMessage = (data: RawData, binary: boolean): void => {
      if (binary) return
      const event = readUpstreamEvent(mode, data.toString())
      if (event?.type === 'error') finish(new GatewaySessionRefused(null))
      else if (event?.type === 'sessionUpdated') finish(null)
    }
    const onClose = (code: number): void => finish(new GatewaySessionRefused(code))
    const timer = setTimeout(() => finish(null), waitMs)
    socket.on('message', onMessage)
    socket.on('close', onClose)
  })
}

/** Closes a gateway socket: gracefully, dropped if that takes longer than `closeMs`. */
export function closeGateway(socket: WebSocket, closeMs = 5000): void {
  if (socket.readyState === WebSocket.CLOSED) return
  if (socket.readyState !== WebSocket.OPEN) {
    socket.terminate()
    return
  }
  socket.close(1000)
  setTimeout(() => socket.terminate(), closeMs).unref()
}

/**
 * Why a gateway refused, decided on what it did, never on its words. A refused handshake with 401
 * or 403 asks the gateway's model list with the same key: a list that fails as well means the key,
 * one without the model that the key may not use it (as LiteLLM lists only the models a key may
 * use), one with it a refusal for another reason.
 */
export async function unavailableReason(
  error: unknown,
  target: RealtimeTarget,
  signal?: AbortSignal
): Promise<TranscriptionRealtimeUnavailableReason> {
  if (error instanceof GatewayUnreachable) return 'gatewayUnreachable'
  if (!(error instanceof GatewayRefused) || (error.status !== 401 && error.status !== 403)) {
    return 'gatewayRefused'
  }
  try {
    const models = await listModels(target.apiBase, target.apiKey, signal)
    return models.some((model) => model.id === target.model) ? 'gatewayRefused' : 'modelNotAllowed'
  } catch (listError) {
    if (signal?.aborted) throw listError
    if (
      listError instanceof UpstreamError &&
      (listError.status === 401 || listError.status === 403)
    ) {
      return 'gatewayKeyRejected'
    }
    return 'gatewayRefused'
  }
}

/** What a probe found: the gateway took the session, or why not with its status if it gave one. */
export type ProbeResult =
  | { ok: true }
  | { ok: false; reason: TranscriptionRealtimeUnavailableReason; status: number | null }

/**
 * Whether the gateway takes key and model: one realtime stream opened, its session set up, a
 * moment's wait for a refusal (`PROBE_WAIT_MS`), closed again. No audio.
 */
export async function probeGateway(
  target: RealtimeTarget,
  signal: AbortSignal = new AbortController().signal,
  { timeoutMs = HANDSHAKE_TIMEOUT_MS, waitMs = PROBE_WAIT_MS } = {}
): Promise<ProbeResult> {
  let socket: WebSocket
  try {
    socket = await openGateway(target, signal, timeoutMs)
  } catch (error) {
    if (signal.aborted) throw error
    return {
      ok: false,
      reason: await unavailableReason(error, target, signal),
      status: error instanceof GatewayRefused ? error.status : null
    }
  }
  try {
    const refusal = await refusalOf(socket, target.mode, waitMs)
    return refusal ? { ok: false, reason: 'gatewayRefused', status: null } : { ok: true }
  } finally {
    closeGateway(socket)
  }
}

/** How long a probe's finding holds: a working gateway for a while, a refusal only briefly. */
export const AVAILABLE_TTL_MS = 5 * 60_000
export const UNAVAILABLE_TTL_MS = 30_000
/** The live tab's config waits this long for a probe. */
const CONFIG_PROBE_TIMEOUT_MS = 5000

type Availability = { reason: TranscriptionRealtimeUnavailableReason; model: string } | null

const availability = new Map<string, { expires: number; value: Promise<Availability> }>()

/** One target's cache entry; the key only as a digest. */
function cacheKey(target: RealtimeTarget): string {
  return createHash('sha256')
    .update(JSON.stringify([target.mode, target.url, target.model, target.apiKey]))
    .digest('hex')
}

/** Notes what a session or probe found, so the live tab's config shows it. */
export function rememberAvailability(
  target: RealtimeTarget,
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
 * Why a mode cannot run right now, or `null` while it can, from a cached probe. A probe that
 * cannot tell (the server is shutting down, say) counts as available: the session says why.
 */
export function realtimeAvailability(
  target: RealtimeTarget,
  now = Date.now()
): Promise<Availability> {
  const key = cacheKey(target)
  const cached = availability.get(key)
  if (cached && cached.expires > now) return cached.value
  const value = probeGateway(target, AbortSignal.timeout(CONFIG_PROBE_TIMEOUT_MS + 1000), {
    timeoutMs: CONFIG_PROBE_TIMEOUT_MS
  }).then(
    (result): Availability => {
      if (result.ok) return null
      console.warn(
        `Transcription live: the ${target.mode} gateway is unavailable (${result.reason}${
          result.status === null ? '' : `, status ${result.status}`
        })`
      )
      return { reason: result.reason, model: target.model }
    },
    (): Availability => null
  )
  availability.set(key, { expires: now + UNAVAILABLE_TTL_MS, value })
  void value.then((found) => {
    const entry = availability.get(key)
    if (entry?.value === value)
      entry.expires = now + (found ? UNAVAILABLE_TTL_MS : AVAILABLE_TTL_MS)
  })
  return value
}
