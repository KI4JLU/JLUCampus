import { bearer, UpstreamError, upstreamFetch } from '../http.js'
import { upstreamLimiter, type ConcurrencyLimiter } from './limiter.js'

/**
 * Requests to the speech and diarisation servers as kiChat's `CustomSpeachesProvider` sends them:
 * every request holds a permit of the shared budget (`upstreamLimiter`) and transient failures
 * are retried, with kiChat's two policies:
 *
 * - A speech chunk (`transcribeAudioParallel`, `withRetry` with `isRetryable`) is tried again
 *   after every transport failure, a timeout included (Laravel's `ConnectionException`), and 5xx.
 * - Diarisation and VAD (`postToServer`) are tried again after transport failures and 5xx, but
 *   not after a processing timeout: kiChat's cURL timed out after connecting, so the server had
 *   the request, and the identical request would burn the same time again. Node's fetch cannot
 *   tell when it connected; undici gives up connecting after 10 s with a transport error (which
 *   is retried), and these deadlines are far longer, so a passed deadline stands in for kiChat's
 *   processing timeout. It does not prove that the server was still working on the audio.
 */

/** kiChat's `transcription.retry_times`: attempts of a chunk's transcription in all. */
export const ASR_RETRY_TIMES = 3
/** kiChat's `transcription.retry_delay_ms`: the fixed pause between those attempts. */
export const ASR_RETRY_DELAY_MS = 3000
/** `postToServer`'s attempts for diarisation and VAD; it pauses `2 × attempt` seconds between. */
export const SERVER_ATTEMPTS = 3

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    const abort = (): void => {
      clearTimeout(timer)
      reject(signal!.reason)
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

/**
 * Whether kiChat's parallel transcription tries a chunk again (its `retry` callback): every
 * transport failure, a timeout included, and `5xx`; never a `4xx` answer (that will not change).
 */
export function isRetryable(error: unknown): boolean {
  return error instanceof UpstreamError && (error.status === null || error.status >= 500)
}

/**
 * `isRetryable` without requests that ran past their deadline, for the correction's chat
 * requests (a Campus addition, kiChat does not retry them): a long answer that timed out would
 * only take as long again.
 */
export function isRetryableInTime(error: unknown): boolean {
  return isRetryable(error) && !(error as UpstreamError).timedOut
}

/** What `postToServer` answers: the body and status, or the transport error it ended with. */
export interface ServerAnswer {
  body: string
  status: number
  /** Empty when the server answered; the reason otherwise. */
  error: string
  /** The error was a processing timeout. */
  timedOut: boolean
}

export interface ServerPost {
  apiKey: string | null
  timeoutMs: number
  /** For logs, e.g. `diarization`. */
  label: string
  signal?: AbortSignal
  maxAttempts?: number
  limiter?: ConcurrencyLimiter
  /** The pause before attempt `attempt + 1`; kiChat sleeps `2 × attempt` seconds. */
  backoffMs?: (attempt: number) => number
}

/**
 * kiChat's `postToServer`: one multipart `POST` holding one permit. A `2xx` or `4xx` answer
 * comes back as is; transport errors and `5xx` are tried `maxAttempts` times in all; a processing
 * timeout ends at once. It never throws for the upstream's sake, only for an abort.
 */
export async function postToServer(
  url: string,
  form: FormData,
  options: ServerPost
): Promise<ServerAnswer> {
  const {
    apiKey,
    timeoutMs,
    label,
    signal,
    maxAttempts = SERVER_ATTEMPTS,
    limiter = upstreamLimiter,
    backoffMs = (attempt) => 2000 * attempt
  } = options
  const started = Date.now()
  const permits = await limiter.acquire(1, { label, signal })
  try {
    let last: ServerAnswer = { body: '', status: 0, error: '', timedOut: false }
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await upstreamFetch(url, {
          method: 'POST',
          body: form,
          headers: { Accept: 'application/json', ...bearer(apiKey) },
          timeoutMs,
          signal
        })
        const body = await response.text().catch(() => '')
        if (response.status >= 200 && response.status < 500) {
          const elapsed = Date.now() - started
          if (elapsed > 30_000) {
            console.info(
              `Transcription request '${label}' succeeded after ${(elapsed / 1000).toFixed(1)} s (budget ${Math.round(timeoutMs / 1000)} s).`
            )
          }
          return { body, status: response.status, error: '', timedOut: false }
        }
        last = { body, status: response.status, error: '', timedOut: false }
      } catch (error) {
        if (signal?.aborted || !(error instanceof UpstreamError)) throw error
        if (error.timedOut) {
          console.warn(
            `Transcription request '${label}' exceeded its ${Math.round(timeoutMs / 1000)} s budget while the server was still processing it; not retrying.`
          )
          return {
            body: '',
            status: 0,
            error: `Zeitüberschreitung nach ${Math.round(timeoutMs / 1000)}s`,
            timedOut: true
          }
        }
        last = { body: '', status: 0, error: error.message, timedOut: false }
      }
      if (attempt < maxAttempts) {
        console.warn(
          `Transcription request '${label}' failed transiently (attempt ${attempt}/${maxAttempts})`,
          last.status || last.error
        )
        await sleep(backoffMs(attempt), signal)
      }
    }
    return last
  } finally {
    permits.release()
  }
}

/**
 * Laravel's `retry($times, $sleepMs, $when)` as kiChat's parallel transcription uses it: `call`
 * runs up to `times` times with `delayMs` between, again only for what `when` accepts
 * (`isRetryable`, as kiChat's speech chunks).
 */
export async function withRetry<T>(
  call: () => Promise<T>,
  options: {
    times?: number
    delayMs?: number
    signal?: AbortSignal
    when?: (error: unknown) => boolean
  } = {}
): Promise<T> {
  const {
    times = ASR_RETRY_TIMES,
    delayMs = ASR_RETRY_DELAY_MS,
    signal,
    when = isRetryable
  } = options
  for (let attempt = 1; ; attempt++) {
    try {
      return await call()
    } catch (error) {
      if (signal?.aborted || attempt >= Math.max(1, times) || !when(error)) throw error
      await sleep(delayMs, signal)
    }
  }
}
