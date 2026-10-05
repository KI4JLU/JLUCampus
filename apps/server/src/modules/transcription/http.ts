import type { TranscriptionModel } from '@justcampus/shared'
import { z, type ZodType } from 'zod'

import { ApiError } from '../../api.js'

/**
 * Requests to the module's upstreams (speech, diarisation, chat, realtime): no redirects, a
 * timeout, and cancelled with the caller's signal. Keys go in headers only; what an upstream
 * answers is masked before it reaches an error (`maskSecrets`), so errors may be logged.
 *
 * Masking does not depend on a key's shape or length: every credential a request carried
 * (`upstreamFetch` notes them per response) is masked in what that request's answer says, the
 * whole text before it is cut short. Keys sent lately (`rememberKey`) of `RECENT_KEY_MIN`
 * characters or more and key-like strings are masked besides, for texts that reach an error
 * without their response; a shorter one would garble unrelated text.
 *
 * What an upstream answered goes into an error's `detail` only, for logs; its `message` is the
 * server's own words, and its `kind` and `status` say how the request failed, decided on the raw
 * answer before anything is masked. Callers decide by those, never by the masked words.
 */

/** Keys this server sent to upstreams lately, newest last; `maskSecrets` hides them. */
const sentKeys = new Set<string>()
/** Enough for every key of the module's settings and the admin form's tries. */
const SENT_KEYS_MAX = 64
/**
 * Keys sent lately are masked in other requests' texts from this length on. A request's own keys
 * are masked whatever their length (`secretsOfResponse`).
 */
export const RECENT_KEY_MIN = 8

/** The credentials the request of each response carried (`upstreamFetch`). */
const requestSecrets = new WeakMap<Response, readonly string[]>()

/** What a masked key reads as. */
const MASK = '***'

/** Notes a key that goes to an upstream, so errors and logs that reflect it mask it. */
export function rememberKey(key: string | null | undefined): void {
  if (!key) return
  sentKeys.delete(key)
  sentKeys.add(key)
  if (sentKeys.size > SENT_KEYS_MAX) sentKeys.delete(sentKeys.values().next().value!)
}

/** Forgets the keys noted (tests). */
export function forgetKeys(): void {
  sentKeys.clear()
}

/** Headers whose values are credentials. */
const secretHeader = /authorization|key|token|secret|password|cookie/i

/**
 * The credentials among request headers, whatever their shape: the values of `Authorization`,
 * `X-Gateway-Key` and the like, and the token after an auth scheme (`Bearer <key>`).
 */
export function secretsOf(headers: RequestInit['headers']): string[] {
  const secrets: string[] = []
  new Headers(headers).forEach((value, name) => {
    if (!secretHeader.test(name) || !value.trim()) return
    secrets.push(value)
    const token = /^\S+\s+(.+)$/.exec(value.trim())?.[1]
    if (token) secrets.push(token)
  })
  return secrets
}

/** The credentials the request of `response` carried; none for a response from elsewhere. */
export function secretsOfResponse(response: Response): readonly string[] {
  return requestSecrets.get(response) ?? []
}

/** How a key may appear in an answer: as it is, escaped in JSON, encoded in a URL. */
function spellings(key: string): string[] {
  return [key, JSON.stringify(key).slice(1, -1), encodeURIComponent(key)]
}

/**
 * `text` with every key masked: those given (the request's own) however short, the keys sent to
 * an upstream lately (`bearer`) from `RECENT_KEY_MIN` characters on, and anything that looks like
 * one (`Bearer …`, `sk-…`, `api_key=…`). Longer keys go first, so a key inside another leaves no
 * rest of the longer one.
 * For upstream answers before they reach a log, an error detail or a client: a gateway may
 * reflect the key it refused. Mask the whole text first and cut it short afterwards: cut first,
 * the start of a key at the cut would stay.
 */
export function maskSecrets(
  text: string,
  keys: readonly (string | null | undefined)[] = []
): string {
  const masked = new Set<string>()
  const recent = [...sentKeys].filter((key) => key.length >= RECENT_KEY_MIN)
  for (const key of [...keys, ...recent]) {
    if (key) for (const spelling of spellings(key)) masked.add(spelling)
  }
  let safe = text
  for (const key of [...masked].sort((a, b) => b.length - a.length)) {
    safe = safe.split(key).join(MASK)
  }
  return safe
    .replace(/Bearer\s+(?!\*\*\*)[^\s"',;)\]}]+/gi, 'Bearer ***')
    .replace(/\bsk-(?!\*\*\*)[\w-]{6,}/g, 'sk-***')
    .replace(
      /((?:api[_-]?key|access[_-]?token|x-gateway-key|authorization)["']?\s*[:=]\s*["']?)(?!\*\*\*|Bearer)[^\s"',;)\]}]+/gi,
      '$1***'
    )
}

/** Characters of an upstream error body kept as detail. */
export const DETAIL_MAX = 500

/**
 * How an upstream request failed, decided on the raw answer: not answered (`unreachable`), not in
 * time (`timeout`), an error status (`status`), or a 2xx answer that is no JSON or of another
 * shape (`invalidAnswer`).
 */
export type UpstreamFailure = 'unreachable' | 'timeout' | 'status' | 'invalidAnswer'

/**
 * An upstream that did not answer, answered with an error status or with something unexpected.
 * Message and detail are masked (`maskSecrets`) with the request's `secrets`, the detail before
 * it is cut to `DETAIL_MAX`, so the error can be logged as it is. Decide by `kind`, `status` and
 * `timedOut`, never by the masked message: a short key may have changed its words.
 */
export class UpstreamError extends Error {
  /** The start of its answer, masked, for logs only. */
  readonly detail: string | null
  /** How the request failed, from the raw answer (`UpstreamFailure`). */
  readonly kind: UpstreamFailure

  /** A 2xx answer that is no JSON or not of the shape asked for. */
  static invalidAnswer(
    message: string,
    status: number | null,
    detail: string | null = null,
    secrets: readonly (string | null | undefined)[] = []
  ): UpstreamError {
    return new UpstreamError(message, status, detail, false, secrets, 'invalidAnswer')
  }

  constructor(
    message: string,
    /** The upstream's HTTP status, if it answered. */
    readonly status: number | null = null,
    /** The upstream's whole answer or cause; masked, then cut short. */
    detail: string | null = null,
    /**
     * The request ran past its deadline (`timeoutMs`). Whether that is worth another attempt
     * depends on the request: kiChat retries a speech chunk that timed out, not a diarisation.
     */
    readonly timedOut = false,
    /** The credentials of the request, masked whatever their shape (`secretsOf`). */
    secrets: readonly (string | null | undefined)[] = [],
    /** Left out: `timeout`, `unreachable` without a status, else `status`. */
    kind?: UpstreamFailure
  ) {
    super(maskSecrets(message, secrets))
    this.name = 'UpstreamError'
    this.detail = detail ? maskSecrets(detail, secrets).slice(0, DETAIL_MAX) || null : null
    this.kind = kind ?? (timedOut ? 'timeout' : status === null ? 'unreachable' : 'status')
  }
}

export interface UpstreamInit extends RequestInit {
  /** Gives up after this; the default suits a quick JSON call. */
  timeoutMs?: number
  /** The caller's signal, e.g. the client's request or the worker's cancellation. */
  signal?: AbortSignal
  /** Credentials the request carries outside its headers; masked like those (`secretsOf`). */
  secrets?: readonly (string | null | undefined)[]
}

/** `base` up to `/v1` joined with `path`, with exactly one slash between. */
export function upstreamUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

/**
 * `Authorization: Bearer <key>` when there is a key; the key is noted for `maskSecrets`, and
 * `upstreamFetch` masks it in the answer to this request whatever happens to that note.
 */
export function bearer(apiKey: string | null | undefined): Record<string, string> {
  rememberKey(apiKey)
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
}

/**
 * `fetch` for upstreams: refuses redirects, times out, follows the caller's signal. A network
 * failure or timeout becomes an `UpstreamError` without status; the response is returned as is.
 */
export async function upstreamFetch(url: string, init: UpstreamInit = {}): Promise<Response> {
  const { timeoutMs = 60_000, signal, secrets: extra = [], ...rest } = init
  const timeout = AbortSignal.timeout(timeoutMs)
  const secrets = [...secretsOf(rest.headers), ...extra.filter((key): key is string => !!key)]
  try {
    const response = await fetch(url, {
      ...rest,
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    })
    requestSecrets.set(response, secrets)
    return response
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    const reason = timeout.aborted ? `timed out after ${timeoutMs} ms` : 'is unreachable'
    throw new UpstreamError(
      `${new URL(url).host} ${reason}`,
      null,
      String(error),
      timeout.aborted,
      secrets
    )
  }
}

/**
 * Throws an `UpstreamError` with status and the start of the body unless the answer is 2xx; the
 * body is masked with the request's credentials (`upstreamFetch`) and `secrets`.
 */
export async function ensureOk(
  response: Response,
  label: string,
  secrets: readonly (string | null | undefined)[] = []
): Promise<Response> {
  if (response.ok) return response
  const body = await response.text().catch(() => '')
  throw new UpstreamError(
    `${label} answered with status ${response.status}`,
    response.status,
    body || null,
    false,
    [...secretsOfResponse(response), ...secrets]
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
    throw UpstreamError.invalidAnswer(`${label} did not answer with JSON`, response.status)
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    throw UpstreamError.invalidAnswer(
      `${label} answered in an unexpected shape`,
      response.status,
      JSON.stringify(body),
      secretsOfResponse(response)
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
    throw UpstreamError.invalidAnswer(
      'The model list answered in an unexpected shape',
      response.status
    )
  }
}
