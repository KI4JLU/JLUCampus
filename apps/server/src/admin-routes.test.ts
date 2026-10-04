import { adminUserListSchema } from '@justcampus/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  actorId: 'alice',
  actorRole: 'admin',
  authenticated: true,
  targetId: 'bob',
  rows: [] as Array<Record<string, unknown>>,
  locked: false
}))

vi.mock('./auth.js', () => ({
  auth: { handler: vi.fn() },
  getSession: async () =>
    state.authenticated ? { user: { id: state.actorId, role: state.actorRole } } : null
}))
vi.mock('./env.js', () => ({
  env: {
    CORS_ORIGINS: ['http://test'],
    BETTER_AUTH_URL: 'http://test',
    FEED_ALLOW_PRIVATE_HOSTS: false
  }
}))
vi.mock('./modules/index.js', () => ({ registerModuleRoutes: vi.fn() }))
vi.mock('./db/index.js', () => {
  const db = {
    select: () => {
      const query = {
        from: () => query,
        where: () => query,
        orderBy: () => query,
        for: () => {
          state.locked = true
          return query
        },
        then: (resolve: (rows: typeof state.rows) => unknown) =>
          Promise.resolve(state.rows).then(resolve)
      }
      return query
    },
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            const row = state.rows.find((row) => row.id === state.targetId)!
            Object.assign(row, values)
            return [row]
          }
        })
      })
    }),
    transaction: async (run: (transaction: unknown) => Promise<unknown>) => run(db)
  }
  return { db }
})

import { app } from './app.js'

describe('admin user routes', () => {
  beforeEach(() => {
    state.actorId = 'alice'
    state.actorRole = 'admin'
    state.authenticated = true
    state.targetId = 'bob'
    state.locked = false
    state.rows = [
      { id: 'carol', name: 'Aaron', role: 'user' },
      { id: 'bob', name: 'bob', role: 'admin' },
      { id: 'alice', name: 'Alice', role: 'admin' }
    ].map((row) => ({
      ...row,
      email: `${row.id}@example.com`,
      image: null,
      keycloakRoles: [],
      keycloakGroups: [],
      createdAt: new Date('2026-10-04T12:00:00Z'),
      lastSignInAt: null
    }))
  })

  async function patch(id: string, body: unknown): Promise<Response> {
    state.targetId = id
    return app.request(`/api/admin/users/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
  }

  it('lists users in contract order with ISO dates', async () => {
    const response = await app.request('/api/admin/users')
    expect(response.status).toBe(200)
    const body = adminUserListSchema.parse(await response.json())
    expect(body.users.map((row: { id: string }) => row.id)).toEqual(['alice', 'bob', 'carol'])
    expect(body.users[0]).toMatchObject({
      createdAt: '2026-10-04T12:00:00.000Z',
      lastSignInAt: null
    })
  })

  it('changes a role under a row lock and returns the updated contract', async () => {
    const response = await patch('bob', { role: 'user' })
    expect(response.status).toBe(200)
    expect(state.locked).toBe(true)
    expect(await response.json()).toMatchObject({ id: 'bob', role: 'user' })
  })

  it('rejects self-revocation and unknown users', async () => {
    const self = await patch('alice', { role: 'user' })
    expect(self.status).toBe(409)
    expect(await self.json()).toMatchObject({ error: { code: 'conflict' } })
    const missing = await patch('unknown', { role: 'admin' })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ error: { code: 'not_found' } })
  })

  it('validates roles and malformed JSON using the existing error shape', async () => {
    const invalid = await patch('bob', { role: 'owner' })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({
      error: { code: 'validation', issues: [{ path: ['role'] }] }
    })
    const malformed = await app.request('/api/admin/users/bob', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: '{'
    })
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toMatchObject({ error: { code: 'validation' } })
  })

  it('protects the last admin after a concurrent revocation', async () => {
    state.rows.find((row) => row.id === 'alice')!.role = 'user'
    expect((await patch('bob', { role: 'user' })).status).toBe(409)
    expect(state.rows.find((row) => row.id === 'bob')!.role).toBe('admin')
  })

  it('requires an admin session for both routes', async () => {
    state.actorRole = 'user'
    expect((await app.request('/api/admin/users')).status).toBe(403)
    expect((await patch('bob', { role: 'user' })).status).toBe(403)
    state.authenticated = false
    expect((await app.request('/api/admin/users')).status).toBe(401)
    expect((await patch('bob', { role: 'user' })).status).toBe(401)
  })
})
