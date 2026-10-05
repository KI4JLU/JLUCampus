import type { TranscriptionModel } from '@justcampus/shared'
import { z, type ZodType } from 'zod'

import { ApiError } from '../../api.js'

/**
 * Requests to the module's upstreams (speech, diarisation, chat, realtime): no redirects, a
 * timeout, and cancelled with the caller's signal. Keys go in `Authorization` only; what an
 * upstream answers is masked before it reaches an error (`maskSecrets`), so errors may be logged.
 */

/** Keys this server sent to upstreams lately, newest last; `maskSecrets` hides them. */
const sentKeys = new Set<string>()
/** Enough for every key of the module's settings and the admin form's tries. */
const SENT_KEYS_MAX = 64
/** Shorter strings are no keys and would mask ordinary text. */
const KEY_MIN = 8

/** Notes a key that goes to an upstream, so errors and logs that reflect it mask it. */
export function rememberKey(key: string | null | undefined): void {
  if (!key || key.length < KEY_MIN) return
  sentKeys.delete(key)
  sentKeys.add(key)
  if (sentKeys.size > SENT_KEYS_MAX) sentKeys.delete(sentKeys.values().next().value!)
}

/** Forgets the keys noted (tests). */
export function forgetKeys(): void {
  sentKeys.clear()
}

/**
 * `text` with every key masked: those given, every key sent to an upstream lately (`bearer`), and
 * anything that looks like one (`Bearer …`, `sk-…`, `api_key=…`). For upstream answers before they
 * reach a log, an error detail or a client: a gateway may reflect the key it refused.
 */
export function maskSecrets(
  text: string,
  keys: readonly (string | null | undefined)[] = []
): string {
  let safe = text
  for (const key of keys) if (key && key.length >= 4) safe = safe.split(key).join('***')
  for (const key of sentKeys) safe = safe.split(key).join('***')
  return safe
    .replace(/Bearer\s+(?!\*\*\*)[^\s"',;)\]}]+/gi, 'Bearer ***')
    .replace(/\bsk-(?!\*\*\*)[\w-]{6,}/g, 'sk-***')
    .replace(
      /((?:api[_-]?key|access[_-]?token|x-gateway-key|authorization)["']?\s*[:=]\s*["']?)(?!\*\*\*|Bearer)[^\s"',;)\]}]+/gi,
      '$1***'
    )
}

/**
 * An upstream that did not answer, answered with an error status or with something unexpected.
 * Message and detail are masked (`maskSecrets`), so the error can be logged as it is.
 */
export class UpstreamError extends Error {
  /** The start of its answer, masked, for logs and safe error detail. */
  readonly detail: string | null

  constructor(
    message: string,
    /** The upstream's HTTP status, if it answered. */
    readonly status: number | null = null,
    detail: string | null = null,
    /**
     * The request ran past its deadline (`timeoutMs`). Whether that is worth another attempt
     * depends on the request: kiChat retries a speech chunk that timed out, not a diarisation.
     */
    readonly timedOut = false
  ) {
    super(maskSecrets(message))
    this.name = 'UpstreamError'
    this.detail = detail === null ? null : maskSecrets(detail)
  }
}

/** Characters of an upstream error body kept as detail. */
const DETAIL_MAX = 500

export interface UpstreamInit extends RequestInit {
  /** Gives up after this; the default suits a quick JSON call. */
  timeoutMs?: number
  /** The caller's signal, e.g. the client's request or the worker's cancellation. */
  signal?: AbortSignal
}

/** `base` up to `/v1` joined with `path`, with exactly one slash between. */
export function upstreamUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

/** `Authorization: Bearer <key>` when there is a key; the key is noted for `maskSecrets`. */
export function bearer(apiKey: string | null | undefined): Record<string, string> {
  rememberKey(apiKey)
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
}

/**
 * `fetch` for upstreams: refuses redirects, times out, follows the caller's signal. A network
 * failure or timeout becomes an `UpstreamError` without status; the response is returned as is.
 */
export async function upstreamFetch(url: string, init: UpstreamInit = {}): Promise<Response> {
  const { timeoutMs = 60_000, signal, ...rest } = init
  const timeout = AbortSignal.timeout(timeoutMs)
  try {
    return await fetch(url, {
      ...rest,
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    })
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    const reason = timeout.aborted ? `timed out after ${timeoutMs} ms` : 'is unreachable'
    throw new UpstreamError(
      `${new URL(url).host} ${reason}`,
      null,
      String(error).slice(0, 200),
      timeout.aborted
    )
  }
}

/** Throws an `UpstreamError` with status and the start of the body unless the answer is 2xx. */
export async function ensureOk(response: Response, label: string): Promise<Response> {
  if (response.ok) return response
  const body = await response.text().catch(() => '')
  throw new UpstreamError(
    `${label} answered with status ${response.status}`,
    response.status,
    body.slice(0, DETAIL_MAX) || null
  )
}

/** The answer's JSON checked against `schema`, else an `UpstreamError`. */
export async function readJson<T>(
  response: Response,
  schema: ZodType<T>,
  label: string
): Promise<T> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new UpstreamError(`${label} did not answer with JSON`, response.status)
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    throw new UpstreamError(
      `${label} answered in an unexpected shape`,
      response.status,
      JSON.stringify(body).slice(0, DETAIL_MAX)
    )
  }
  return parsed.data
}

/** A JSON request whose 2xx answer must match `schema`. */
export async function fetchJson<T>(
  url: string,
  schema: ZodType<T>,
  init: UpstreamInit & { label: string }
): Promise<T> {
  const { label, ...rest } = init
  const headers = new Headers(rest.headers)
  headers.set('Accept', 'application/json')
  const response = await ensureOk(await upstreamFetch(url, { ...rest, headers }), label)
  return readJson(response, schema, label)
}

/**
 * Runs an upstream call for a route: upstream failures become `502 module_unavailable` with
 * `message`, the route's own `ApiError`s pass, and the cause is logged without credentials.
 */
export async function upstream<T>(message: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof ApiError) throw error
    console.error(`Transcription upstream failed: ${message}`, error)
    throw new ApiError(502, 'module_unavailable', message)
  }
}

const modelListSchema = z.object({
  data: z.array(z.object({ id: z.string(), name: z.unknown().optional() }))
})

/**
 * The models of an OpenAI-compatible `/models` answer in the endpoint's order, labelled with their
 * `name` if given, else their id. Nothing is filtered: callers pick speech or chat models.
 */
export function parseModels(body: unknown): TranscriptionModel[] {
  const seen = new Set<string>()
  const models: TranscriptionModel[] = []
  for (const entry of modelListSchema.parse(body).data) {
    const id = entry.id.trim()
    if (!id || id.length > 200 || seen.has(id)) continue
    seen.add(id)
    const name = typeof entry.name === 'string' ? entry.name.trim() : ''
    models.push({ id, label: (name || id).slice(0, 80).trim() })
  }
  return models
}

/** `GET <baseUrl>/models` of an OpenAI-compatible endpoint. */
export async function listModels(
  baseUrl: string,
  apiKey: string | null,
  signal?: AbortSignal
): Promise<TranscriptionModel[]> {
  const response = await ensureOk(
    await upstreamFetch(upstreamUrl(baseUrl, 'models'), {
      headers: { Accept: 'application/json', ...bearer(apiKey) },
      timeoutMs: 15_000,
      signal
    }),
    'The model list'
  )
  try {
    return parseModels(await response.json())
  } catch {
    throw new UpstreamError('The model list answered in an unexpected shape', response.status)
  }
}
