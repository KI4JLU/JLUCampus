import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GatewayUnreachable, openGateway, type RealtimeTarget } from './gateway.js'

/**
 * The CONNECT to the outbound proxy with `node:http`'s `request` replaced (review W-9): no socket
 * is created, a request that never answers stands for a stalled proxy.
 */
const requests = vi.hoisted(() => [] as { destroyed: boolean }[])

vi.mock('node:http', async (original) => {
  const actual = await original<typeof import('node:http')>()
  const { EventEmitter } = await import('node:events')
  class StalledRequest extends EventEmitter {
    destroyed = false
    destroy(): this {
      this.destroyed = true
      return this
    }
    end(): this {
      return this
    }
  }
  return {
    ...actual,
    request: () => {
      const request = new StalledRequest()
      requests.push(request)
      return request
    }
  }
})

const target: RealtimeTarget = {
  mode: 'onprem',
  apiBase: 'http://gateway.invalid/v1',
  url: 'ws://gateway.invalid/v1/realtime?model=m',
  apiKey: null,
  model: 'm'
}

describe('cancelling the gateway handshake through the proxy (W-9)', () => {
  beforeEach(() => {
    requests.length = 0
    vi.stubEnv('HTTP_PROXY', 'http://127.0.0.1:9')
    vi.stubEnv('NODE_USE_ENV_PROXY', '1')
    vi.stubEnv('NO_PROXY', '')
  })
  afterEach(() => vi.unstubAllEnvs())

  it('creates nothing for a caller that gave up already', async () => {
    const controller = new AbortController()
    controller.abort(new Error('Session closed'))
    const opening = openGateway(target, controller.signal, 10)
    const outcome = await Promise.race([
      opening.then(
        () => 'opened',
        (error: unknown) => error
      ),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 35))
    ])
    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toBe('Session closed')
    expect(requests).toHaveLength(0)
  })

  it('destroys a stalled CONNECT when the caller gives up meanwhile', async () => {
    const controller = new AbortController()
    const opening = openGateway(target, controller.signal, 10_000)
    expect(requests).toHaveLength(1)
    controller.abort(new Error('Session closed'))
    await expect(opening).rejects.toThrow('Session closed')
    expect(requests[0]!.destroyed).toBe(true)
  })

  it('destroys a stalled CONNECT at the handshake deadline', async () => {
    const opening = openGateway(target, new AbortController().signal, 20)
    const error = await opening.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(GatewayUnreachable)
    expect((error as GatewayUnreachable).timedOut).toBe(true)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.destroyed).toBe(true)
  })
})
