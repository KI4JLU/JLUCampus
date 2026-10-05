import { describe, expect, it, vi, type Mock } from 'vitest'

import {
  createKeycloakSessionKeeper,
  keycloakTokenRefresher,
  type KeycloakRefresh,
  type KeycloakSessionKeeper,
  type KeycloakSessionRecord
} from './keycloak-session.js'

const minute = 60_000
const start = new Date('2026-10-05T10:00:00Z')

interface Setup {
  keeper: KeycloakSessionKeeper
  refresh: Mock<(refreshToken: string) => Promise<KeycloakRefresh>>
  ended: string[]
  record: () => KeycloakSessionRecord | null
  advance: (ms: number) => void
}

function setup(record: KeycloakSessionRecord | null, refreshResult: KeycloakRefresh): Setup {
  let current = record
  let time = start
  const refresh = vi.fn<(refreshToken: string) => Promise<KeycloakRefresh>>(
    async () => refreshResult
  )
  const ended: string[] = []
  const keeper = createKeycloakSessionKeeper({
    refresh,
    now: () => time,
    store: {
      read: async () => current,
      save: async (_sessionId, refreshToken, checkedAt) => {
        current = { refreshToken, checkedAt }
      },
      end: async (sessionId) => {
        ended.push(sessionId)
        current = null
      }
    }
  })
  return {
    keeper,
    refresh,
    ended,
    record: () => current,
    advance: (ms: number) => {
      time = new Date(time.getTime() + ms)
    }
  }
}

describe('Keycloak session keeper', () => {
  it('trusts a session checked within the interval', async () => {
    const { keeper, refresh } = setup(
      { refreshToken: 'r1', checkedAt: new Date(start.getTime() - minute) },
      { status: 'ended' }
    )
    await expect(keeper.check('s1')).resolves.toBe(true)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('refreshes after the interval and keeps the new token', async () => {
    const { keeper, refresh, record, advance } = setup(
      { refreshToken: 'r1', checkedAt: start },
      { status: 'active', refreshToken: 'r2' }
    )
    advance(5 * minute)
    await expect(keeper.check('s1')).resolves.toBe(true)
    expect(refresh).toHaveBeenCalledWith('r1')
    expect(record()).toEqual({
      refreshToken: 'r2',
      checkedAt: new Date(start.getTime() + 5 * minute)
    })
  })

  it('ends the session when Keycloak has ended it', async () => {
    const { keeper, ended } = setup({ refreshToken: 'r1', checkedAt: null }, { status: 'ended' })
    await expect(keeper.check('s1')).resolves.toBe(false)
    expect(ended).toEqual(['s1'])
  })

  it('keeps the session and checks again next time when Keycloak cannot answer', async () => {
    const { keeper, refresh, ended, record } = setup(
      { refreshToken: 'r1', checkedAt: null },
      { status: 'unavailable' }
    )
    await expect(keeper.check('s1')).resolves.toBe(true)
    await expect(keeper.check('s1')).resolves.toBe(true)
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(ended).toEqual([])
    expect(record()).toEqual({ refreshToken: 'r1', checkedAt: null })
  })

  it('ends a session without a Keycloak token', async () => {
    const { keeper, refresh, ended } = setup(
      { refreshToken: null, checkedAt: null },
      { status: 'active', refreshToken: 'r2' }
    )
    await expect(keeper.check('s1')).resolves.toBe(false)
    expect(refresh).not.toHaveBeenCalled()
    expect(ended).toEqual(['s1'])
  })

  it('refuses a session that no longer exists', async () => {
    const { keeper, ended } = setup(null, { status: 'active', refreshToken: 'r2' })
    await expect(keeper.check('s1')).resolves.toBe(false)
    expect(ended).toEqual([])
  })

  it('spends a refresh token once for parallel requests', async () => {
    const { keeper, refresh } = setup(
      { refreshToken: 'r1', checkedAt: null },
      { status: 'active', refreshToken: 'r2' }
    )
    await expect(Promise.all([keeper.check('s1'), keeper.check('s1')])).resolves.toEqual([
      true,
      true
    ])
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})

describe('Keycloak token refresher', () => {
  function refresher(response: Response | Error): {
    refresh: (refreshToken: string) => Promise<KeycloakRefresh>
    send: Mock
  } {
    const send = vi.fn(async () => {
      if (response instanceof Error) throw response
      return response
    })
    const refresh = keycloakTokenRefresher({
      issuer: 'https://keycloak.test/realms/campus/',
      clientId: 'campus',
      clientSecret: 'secret',
      fetch: send as unknown as typeof fetch
    })
    return { refresh, send }
  }

  it('posts the refresh grant with the client credentials', async () => {
    const { refresh, send } = refresher(Response.json({ refresh_token: 'r2' }))
    await expect(refresh('r1')).resolves.toEqual({ status: 'active', refreshToken: 'r2' })
    const [url, init] = send.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://keycloak.test/realms/campus/protocol/openid-connect/token')
    expect(Object.fromEntries(init.body as URLSearchParams)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'r1',
      client_id: 'campus',
      client_secret: 'secret'
    })
  })

  it('reads invalid_grant as an ended session', async () => {
    const { refresh } = refresher(
      Response.json(
        { error: 'invalid_grant', error_description: 'Session not active' },
        { status: 400 }
      )
    )
    await expect(refresh('r1')).resolves.toEqual({ status: 'ended' })
  })

  it.each([
    ['a client error', Response.json({ error: 'unauthorized_client' }, { status: 401 })],
    ['an outage', new Response('Bad gateway', { status: 502 })],
    ['an unreachable server', new TypeError('fetch failed')]
  ])('reads %s as unavailable', async (_label, response) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { refresh } = refresher(response)
    await expect(refresh('r1')).resolves.toEqual({ status: 'unavailable' })
  })
})
