import { afterEach, describe, expect, it, vi } from 'vitest'

import { ConcurrencyLimiter, upstreamLimiter } from './limiter.js'

describe('ConcurrencyLimiter (kiChat’s SpeachesConcurrencyLimiter)', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('gives up to the free permits at once and never more than the limit', async () => {
    const limiter = new ConcurrencyLimiter(3)
    const first = await limiter.acquire(2)
    expect(first.count).toBe(2)
    const second = await limiter.acquire(5)
    expect(second.count).toBe(1)
    expect(limiter.inUse).toBe(3)
    first.release()
    first.release()
    expect(limiter.inUse).toBe(1)
    second.release()
    expect(limiter.inUse).toBe(0)
  })

  it('waits for a free slot and serves waiters in order', async () => {
    const limiter = new ConcurrencyLimiter(1)
    const held = await limiter.acquire(1)
    const order: string[] = []
    const a = limiter.acquire(1).then((permits) => {
      order.push('a')
      return permits
    })
    const b = limiter.acquire(1).then((permits) => {
      order.push('b')
      return permits
    })
    await Promise.resolve()
    expect(order).toEqual([])
    held.release()
    const permitsA = await a
    expect(order).toEqual(['a'])
    permitsA.release()
    ;(await b).release()
    expect(order).toEqual(['a', 'b'])
    expect(limiter.inUse).toBe(0)
  })

  it('proceeds without a permit after the wait, as kiChat fails open', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const limiter = new ConcurrencyLimiter(1)
    await limiter.acquire(1)
    const waiting = limiter.acquire(1, { waitMs: 600_000, label: 'diarization' })
    await vi.advanceTimersByTimeAsync(600_000)
    const permits = await waiting
    expect(permits.count).toBe(0)
    permits.release()
    expect(limiter.inUse).toBe(1)
  })

  it('stops waiting when the job is cancelled', async () => {
    const limiter = new ConcurrencyLimiter(1)
    await limiter.acquire(1)
    const controller = new AbortController()
    const waiting = limiter.acquire(1, { signal: controller.signal })
    controller.abort(new Error('cancelled'))
    await expect(waiting).rejects.toThrow('cancelled')
  })

  it('follows a changed limit', async () => {
    const limiter = new ConcurrencyLimiter(1)
    const held = await limiter.acquire(1)
    const waiting = limiter.acquire(2)
    limiter.setLimit(3)
    expect((await waiting).count).toBe(2)
    held.release()
    expect(limiter.capacity).toBe(3)
  })

  it('is one budget for the whole process, kiChat’s default of three', () => {
    expect(upstreamLimiter.capacity).toBe(3)
  })
})
