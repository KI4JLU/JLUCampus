/**
 * A counting semaphore that bounds the requests in flight at the speech and diarisation servers,
 * ported from kiChat's `SpeachesConcurrencyLimiter`. The limit is a property of the servers (how
 * many model instances run), not of a job: every request holds a permit, whichever job or chunk
 * it belongs to, and all request types (transcription, diarisation, VAD) share one budget.
 *
 * kiChat keeps its slots as cache locks across PHP processes; here the worker's jobs share one
 * process, so the slots live in memory (`upstreamLimiter`). As in kiChat, a caller that waited
 * too long proceeds without a permit (fails open) rather than dropping work.
 */

/** Permits taken by one `acquire`; `release` gives them back once, later calls do nothing. */
export interface Permits {
  readonly count: number
  release: () => void
}

interface Waiter {
  max: number
  grant: (count: number) => void
}

/** How long a caller waits for a free slot before it proceeds without one (kiChat: 600 s). */
export const PERMIT_WAIT_MS = 600_000

/** Waits longer than this are logged, as kiChat logs contended slots. */
const LOG_WAIT_MS = 1000

export class ConcurrencyLimiter {
  private held = 0
  private readonly waiters: Waiter[] = []

  constructor(private limit: number) {
    this.limit = Math.max(1, Math.floor(limit))
  }

  get capacity(): number {
    return this.limit
  }

  /** Permits held right now. */
  get inUse(): number {
    return this.held
  }

  /** Follows the admin's setting; a lower limit lets running requests finish. */
  setLimit(limit: number): void {
    this.limit = Math.max(1, Math.floor(limit))
    this.grantWaiting()
  }

  /**
   * Up to `max` permits, waiting until at least one is free. After `waitMs` it resolves with no
   * permits (the caller proceeds anyway); an aborted `signal` rejects with its reason.
   */
  acquire(
    max: number,
    options: { waitMs?: number; label?: string; signal?: AbortSignal } = {}
  ): Promise<Permits> {
    const { waitMs = PERMIT_WAIT_MS, label = 'unlabeled', signal } = options
    const wanted = Math.max(1, Math.floor(max))
    const free = this.limit - this.held
    if (free > 0 && this.waiters.length === 0) {
      return Promise.resolve(this.take(Math.min(wanted, free)))
    }
    if (signal?.aborted) return Promise.reject(signal.reason)
    const started = Date.now()
    return new Promise<Permits>((resolve, reject) => {
      const waiter: Waiter = {
        max: wanted,
        grant: (count) => {
          cleanup()
          const waited = Date.now() - started
          if (count === 0) {
            console.warn(
              `Transcription limiter: '${label}' timed out after ${(waited / 1000).toFixed(1)} s waiting for a free slot, proceeding without a permit.`
            )
          } else if (waited > LOG_WAIT_MS) {
            console.warn(
              `Transcription limiter: '${label}' waited ${(waited / 1000).toFixed(1)} s for a free slot (${this.held}/${this.limit} held).`
            )
          }
          resolve(count === 0 ? this.none() : this.permits(count))
        }
      }
      const timer = setTimeout(() => {
        this.dequeue(waiter)
        waiter.grant(0)
      }, waitMs)
      const abort = (): void => {
        cleanup()
        this.dequeue(waiter)
        reject(signal!.reason)
      }
      const cleanup = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
      }
      signal?.addEventListener('abort', abort, { once: true })
      this.waiters.push(waiter)
    })
  }

  private take(count: number): Permits {
    this.held += count
    return this.permits(count)
  }

  private permits(count: number): Permits {
    let released = false
    return {
      count,
      release: () => {
        if (released) return
        released = true
        this.held = Math.max(0, this.held - count)
        this.grantWaiting()
      }
    }
  }

  private none(): Permits {
    return { count: 0, release: () => {} }
  }

  private dequeue(waiter: Waiter): void {
    const index = this.waiters.indexOf(waiter)
    if (index >= 0) this.waiters.splice(index, 1)
  }

  /** Hands free slots to the waiters in their order. */
  private grantWaiting(): void {
    while (this.waiters.length > 0 && this.held < this.limit) {
      const waiter = this.waiters.shift()!
      const count = Math.min(waiter.max, this.limit - this.held)
      this.held += count
      waiter.grant(count)
    }
  }
}

/** kiChat's default budget (`transcription.max_concurrency`). */
export const DEFAULT_UPSTREAM_CONCURRENCY = 3

/** The one budget all jobs of this process share; the pipeline sets its limit from the config. */
export const upstreamLimiter = new ConcurrencyLimiter(DEFAULT_UPSTREAM_CONCURRENCY)
