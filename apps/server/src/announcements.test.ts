import {
  ANNOUNCEMENTS_API,
  adminAnnouncementListSchema,
  adminAnnouncementSchema,
  userAnnouncementListSchema,
  type AnnouncementInput
} from '@justcampus/shared'
import { SQL, type AnyColumn } from 'drizzle-orm'
import { PgDialect, type PgTable } from 'drizzle-orm/pg-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { announcement, announcementSeen } from './db/schema.js'

type Row = typeof announcement.$inferSelect
type SeenRow = typeof announcementSeen.$inferSelect
const state = vi.hoisted(() => ({
  actorId: 'alice',
  actorRole: 'admin',
  authenticated: true,
  rows: [] as Row[],
  seen: [] as SeenRow[]
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
  const dialect = new PgDialect()
  function matches(row: Row | SeenRow, condition?: SQL): boolean {
    if (!condition) return true
    const { sql, params } = dialect.sqlToQuery(condition)
    return [...sql.matchAll(/"(id|enabled|announcement_id|user_id)" = \$(\d+)/g)].every(
      ([, column, index]) => {
        const key = column!.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
        return row[key as keyof typeof row] === params[Number(index) - 1]
      }
    )
  }
  function records(table: PgTable): Array<Row | SeenRow> {
    return table === announcement ? state.rows : table === announcementSeen ? state.seen : []
  }
  const db = {
    select: (columns?: Record<string, AnyColumn | SQL>) => {
      let table: PgTable
      let condition: SQL | undefined
      let order: SQL | undefined
      const query = {
        from: (value: PgTable) => {
          table = value
          return query
        },
        where: (value: SQL) => {
          condition = value
          return query
        },
        orderBy: (value: SQL) => {
          order = value
          return query
        },
        for: () => query,
        then: (resolve: (rows: unknown[]) => unknown) => {
          let rows = records(table).filter((row) => matches(row, condition))
          if (order) {
            const field = dialect.sqlToQuery(order).sql.includes('published_at')
              ? 'publishedAt'
              : 'createdAt'
            rows = [...rows].sort(
              (a, b) => (b as Row)[field]!.valueOf() - (a as Row)[field]!.valueOf()
            )
          }
          const result = rows.map((row) => ({
            ...row,
            ...(columns?.seenCount
              ? {
                  seenCount: state.seen.filter((seen) => seen.announcementId === (row as Row).id)
                    .length
                }
              : {}),
            ...(columns?.seen instanceof SQL
              ? {
                  seen: state.seen.some(
                    (seen) =>
                      seen.announcementId === (row as Row).id &&
                      seen.userId === dialect.sqlToQuery(columns.seen as SQL).params[0]
                  )
                }
              : {})
          }))
          return Promise.resolve(result).then(resolve)
        }
      }
      return query
    },
    insert: (table: PgTable) => ({
      values: (values: Record<string, unknown>) => ({
        returning: async () => {
          const row = {
            id: crypto.randomUUID(),
            createdAt: new Date(),
            updatedAt: new Date(),
            ...values
          } as Row
          state.rows.push(row)
          return [row]
        },
        onConflictDoNothing: async () => {
          expect(table).toBe(announcementSeen)
          if (
            !state.seen.some(
              (row) => row.announcementId === values.announcementId && row.userId === values.userId
            )
          ) {
            state.seen.push({ ...values, seenAt: new Date() } as SeenRow)
          }
        }
      })
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: (condition: SQL) => ({
          returning: async () => {
            const rows = state.rows.filter((row) => matches(row, condition))
            for (const row of rows) {
              const publishedAt =
                values.publishedAt instanceof SQL
                  ? (row.publishedAt ?? new Date())
                  : values.publishedAt === announcement.publishedAt
                    ? row.publishedAt
                    : values.publishedAt
              Object.assign(row, values, { publishedAt })
            }
            return rows
          }
        })
      })
    }),
    delete: (table: PgTable) => ({
      where: (condition: SQL) => {
        const removed = records(table).filter((row) => matches(row, condition))
        if (table === announcement) {
          state.rows = state.rows.filter((row) => !removed.includes(row))
          state.seen = state.seen.filter(
            (row) =>
              !removed.some((announcement) => (announcement as Row).id === row.announcementId)
          )
        } else {
          state.seen = state.seen.filter((row) => !removed.includes(row))
        }
        return {
          returning: async () => removed,
          then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(removed).then(resolve)
        }
      }
    }),
    transaction: async (run: (transaction: unknown) => Promise<unknown>) => run(db)
  }
  return { db }
})

import { app } from './app.js'

const id = '11111111-1111-4111-8111-111111111111'
const secondId = '22222222-2222-4222-8222-222222222222'
const input: AnnouncementInput = {
  kind: 'news',
  target: null,
  enabled: true,
  texts: { de: { title: 'Neu', body: 'Nachricht' }, en: { title: 'New', body: 'Message' } }
}

async function request(path: string, method: string, body?: unknown): Promise<Response> {
  return app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined && method !== 'GET' ? { body: JSON.stringify(body) } : {})
  })
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    ...input,
    id,
    publishedAt: new Date('2026-10-01T12:00:00Z'),
    createdAt: new Date('2026-10-01T12:00:00Z'),
    updatedAt: new Date('2026-10-01T12:00:00Z'),
    ...overrides
  }
}

describe('announcement routes', () => {
  beforeEach(() => {
    state.actorId = 'alice'
    state.actorRole = 'admin'
    state.authenticated = true
    state.rows = [row()]
    state.seen = []
  })

  it('requires an admin for every admin endpoint and authentication for user endpoints', async () => {
    state.actorRole = 'user'
    for (const [path, method] of [
      [ANNOUNCEMENTS_API.admin, 'GET'],
      [ANNOUNCEMENTS_API.admin, 'POST'],
      [ANNOUNCEMENTS_API.adminOne(id), 'GET'],
      [ANNOUNCEMENTS_API.adminOne(id), 'PUT'],
      [ANNOUNCEMENTS_API.adminOne(id), 'DELETE'],
      [ANNOUNCEMENTS_API.adminReset(id), 'POST']
    ]) {
      expect((await request(path!, method!, input)).status).toBe(403)
    }
    state.authenticated = false
    expect((await app.request(ANNOUNCEMENTS_API.announcements)).status).toBe(401)
    expect((await request(ANNOUNCEMENTS_API.seen(id), 'POST')).status).toBe(401)
  })

  it('rejects missing English texts on create and replacement', async () => {
    const invalid = { ...input, texts: { de: input.texts.de } }
    for (const [path, method] of [
      [ANNOUNCEMENTS_API.admin, 'POST'],
      [ANNOUNCEMENTS_API.adminOne(id), 'PUT']
    ]) {
      const response = await request(path!, method!, invalid)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        error: { code: 'validation', issues: [{ path: ['texts', 'en'] }] }
      })
    }
  })

  it('validates UUIDs and hint targets', async () => {
    expect((await app.request(ANNOUNCEMENTS_API.adminOne('invalid'))).status).toBe(400)
    expect((await request(ANNOUNCEMENTS_API.seen('invalid'), 'POST')).status).toBe(400)
    expect(
      (await request(ANNOUNCEMENTS_API.admin, 'POST', { ...input, kind: 'hint' })).status
    ).toBe(400)
  })

  it('sets publication time on enabled creation and first enable, then preserves it', async () => {
    const enabled = await request(ANNOUNCEMENTS_API.admin, 'POST', input)
    expect(enabled.status).toBe(201)
    expect(adminAnnouncementSchema.parse(await enabled.json()).publishedAt).not.toBeNull()
    const draft = await request(ANNOUNCEMENTS_API.admin, 'POST', { ...input, enabled: false })
    const created = adminAnnouncementSchema.parse(await draft.json())
    expect(created.publishedAt).toBeNull()
    const firstEnable = await request(ANNOUNCEMENTS_API.adminOne(created.id), 'PUT', input)
    const published = adminAnnouncementSchema.parse(await firstEnable.json()).publishedAt
    expect(published).not.toBeNull()
    for (const enabled of [false, true, true]) {
      const response = await request(ANNOUNCEMENTS_API.adminOne(created.id), 'PUT', {
        ...input,
        enabled
      })
      expect(adminAnnouncementSchema.parse(await response.json()).publishedAt).toBe(published)
    }
  })

  it('lists admin records newest first with counts and replaces all editable fields', async () => {
    state.rows.push(row({ id: secondId, createdAt: new Date('2026-10-02T12:00:00Z') }))
    state.seen = [{ announcementId: id, userId: 'bob', seenAt: new Date() }]
    const response = await app.request(ANNOUNCEMENTS_API.admin)
    const body = adminAnnouncementListSchema.parse(await response.json())
    expect(body.announcements.map((row) => [row.id, row.seenCount])).toEqual([
      [secondId, 0],
      [id, 1]
    ])
    const replacement = {
      ...input,
      kind: 'hint',
      target: { selector: '#dashboard', path: '/' },
      texts: { de: { title: 'Tipp', body: 'Text' }, en: { title: 'Hint', body: 'Text' } },
      enabled: false
    }
    const updated = await request(ANNOUNCEMENTS_API.adminOne(id), 'PUT', replacement)
    expect(adminAnnouncementSchema.parse(await updated.json())).toMatchObject({
      ...replacement,
      seenCount: 1
    })
  })

  it('lists only enabled messages by publication time with the current user seen flag', async () => {
    state.rows = [
      row({ enabled: false }),
      row({ id: secondId }),
      row({ id: crypto.randomUUID(), publishedAt: new Date('2026-10-03T12:00:00Z') })
    ]
    state.seen = [
      { announcementId: secondId, userId: 'alice', seenAt: new Date() },
      { announcementId: state.rows[2]!.id, userId: 'bob', seenAt: new Date() }
    ]
    const response = await app.request(ANNOUNCEMENTS_API.announcements)
    expect(response.status).toBe(200)
    const body = userAnnouncementListSchema.parse(await response.json())
    expect(body.announcements.map((row) => [row.id, row.seen])).toEqual([
      [state.rows[2]!.id, false],
      [secondId, true]
    ])
  })

  it('returns not_found for disabled and unknown seen ids', async () => {
    state.rows[0]!.enabled = false
    for (const targetId of [id, secondId]) {
      const response = await request(ANNOUNCEMENTS_API.seen(targetId), 'POST')
      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({ error: { code: 'not_found' } })
    }
    expect(state.seen).toEqual([])
  })

  it('acknowledges idempotently and resets acknowledgements for all users', async () => {
    const first = await request(ANNOUNCEMENTS_API.seen(id), 'POST')
    expect(first.status).toBe(204)
    expect(await first.text()).toBe('')
    const seenAt = state.seen[0]!.seenAt
    expect((await request(ANNOUNCEMENTS_API.seen(id), 'POST')).status).toBe(204)
    expect(state.seen).toHaveLength(1)
    expect(state.seen[0]!.seenAt).toBe(seenAt)
    state.seen.push({ announcementId: id, userId: 'bob', seenAt: new Date() })
    state.seen.push({ announcementId: secondId, userId: 'bob', seenAt: new Date() })
    const response = await request(ANNOUNCEMENTS_API.adminReset(id), 'POST')
    expect(response.status).toBe(200)
    expect(adminAnnouncementSchema.parse(await response.json()).seenCount).toBe(0)
    expect(state.seen.map((row) => row.announcementId)).toEqual([secondId])
  })

  it('reads and deletes records, and returns not_found for missing admin records', async () => {
    const response = await app.request(ANNOUNCEMENTS_API.adminOne(id))
    expect(adminAnnouncementSchema.parse(await response.json()).id).toBe(id)
    expect((await request(ANNOUNCEMENTS_API.adminOne(id), 'DELETE')).status).toBe(204)
    expect((await app.request(ANNOUNCEMENTS_API.adminOne(id))).status).toBe(404)
    expect((await request(ANNOUNCEMENTS_API.adminOne(id), 'PUT', input)).status).toBe(404)
    expect((await request(ANNOUNCEMENTS_API.adminOne(id), 'DELETE')).status).toBe(404)
    expect((await request(ANNOUNCEMENTS_API.adminReset(id), 'POST')).status).toBe(404)
  })
})
