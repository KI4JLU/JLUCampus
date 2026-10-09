import {
  adminUserListSchema,
  appRoleListSchema,
  appRoleSchema,
  componentListSchema,
  widgetListSchema,
  dashboardSchema,
  meSchema,
  folderTemplateListSchema,
  FEATURE_KEYS
} from '@justcampus/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { hasLiveAccess } from './modules/transcription/realtime/access.js'

const state = vi.hoisted(() => ({
  actorId: 'alice',
  authenticated: true,
  locked: [] as string[],
  revokeActorOnLock: false,
  tables: {} as Record<string, Array<Record<string, unknown>>>
}))
const adminId = '00000000-0000-4000-8000-000000000001'
const everyoneId = '00000000-0000-4000-8000-000000000002'
const customId = '00000000-0000-4000-8000-000000000003'
const componentId = '00000000-0000-4000-8000-000000000004'
const hiddenId = '00000000-0000-4000-8000-000000000005'
const now = new Date('2026-10-04T12:00:00Z')

vi.mock('./auth.js', () => ({
  auth: { handler: vi.fn() },
  getSession: async () => (state.authenticated ? { user: { id: state.actorId } } : null)
}))
vi.mock('./env.js', () => ({
  env: {
    CORS_ORIGINS: ['http://test'],
    BETTER_AUTH_URL: 'http://test',
    FEED_ALLOW_PRIVATE_HOSTS: false
  }
}))
vi.mock('./modules/index.js', () => ({ registerModuleRoutes: vi.fn() }))
vi.mock('./db/index.js', async () => {
  const { getTableName, getTableColumns, sql } = await import('drizzle-orm')
  const { PgDialect } = await import('drizzle-orm/pg-core')
  type Table = Parameters<typeof getTableName>[0]
  type Condition = import('drizzle-orm').SQL
  type Cells = Record<string, Record<string, unknown>>
  const dialect = new PgDialect()

  function matches(condition: Condition | undefined, cells: Cells): boolean {
    if (!condition) return true
    const { sql, params } = dialect.sqlToQuery(condition)
    const tokens =
      sql.match(/"[^"]+"(?:\."[^"]+")?|\$\d+|\b(?:and|or|not|in|false|true|null)\b|=|[(),]/g) ?? []
    let cursor = 0
    function value(): unknown {
      const token = tokens[cursor++]!
      if (token.startsWith('$')) return params[Number(token.slice(1)) - 1]
      if (token === 'null') return null
      if (token === 'false' || token === 'true') return token === 'true'
      const [table, column] = token.replaceAll('"', '').split('.')
      return cells[table!]?.[column!]
    }
    function primary(): boolean {
      if (tokens[cursor] === 'not') {
        cursor++
        return !primary()
      }
      if (tokens[cursor] === '(') {
        cursor++
        const result = expression()
        cursor++
        return result
      }
      const left = value()
      if (tokens[cursor] === '=') {
        cursor++
        return left === value()
      }
      if (tokens[cursor] === 'in') {
        cursor += 2
        const values: unknown[] = [value()]
        while (tokens[cursor] === ',') {
          cursor++
          values.push(value())
        }
        cursor++
        return values.includes(left)
      }
      return Boolean(left)
    }
    function conjunction(): boolean {
      let result = primary()
      while (tokens[cursor] === 'and') {
        cursor++
        const next = primary()
        result = result && next
      }
      return result
    }
    function expression(): boolean {
      let result = conjunction()
      while (tokens[cursor] === 'or') {
        cursor++
        const next = conjunction()
        result = result || next
      }
      return result
    }
    return expression()
  }

  const rows = (table: Table): Array<Record<string, unknown>> =>
    state.tables[getTableName(table)] ?? []
  const cells = (table: Table, row: Record<string, unknown>): Cells => ({
    [getTableName(table)]: Object.fromEntries(
      Object.entries(getTableColumns(table)).map(([key, column]) => [column.name, row[key]])
    )
  })
  interface SelectQuery {
    from(source: Table): SelectQuery
    where(filter: Condition): SelectQuery
    orderBy(): SelectQuery
    limit(count: number): SelectQuery
    innerJoin(source: Table, filter: Condition): SelectQuery
    for(): SelectQuery
    getSQL(): Condition
    then(resolve: (value: unknown[]) => unknown): Promise<unknown>
  }
  const select = (fields?: Record<string, { name: string; table: Table }>): SelectQuery => {
    let table: Table
    let condition: Condition | undefined
    let limit = Infinity
    const joins: Array<{ table: Table; condition: Condition }> = []
    const query = {
      from: (source: Table) => {
        table = source
        return query
      },
      where: (filter: Condition) => {
        condition = filter
        return query
      },
      orderBy: () => query,
      limit: (count: number) => {
        limit = count
        return query
      },
      innerJoin: (source: Table, filter: Condition) => {
        joins.push({ table: source, condition: filter })
        return query
      },
      for: () => {
        state.locked.push(getTableName(table))
        if (state.revokeActorOnLock && getTableName(table) === 'app_role') {
          state.tables.app_role_member = state.tables.app_role_member!.filter(
            (row) => row.userId !== state.actorId
          )
        }
        return query
      },
      getSQL: () => {
        const values = rows(table)
          .filter((row) => matches(condition, cells(table, row)))
          .map((row) => sql`${row.id}`)
        return values.length > 0 ? sql.join(values, sql`, `) : sql`null`
      },
      then: (resolve: (value: unknown[]) => unknown) => {
        let result = rows(table).map((row) => ({ row, cells: cells(table, row) }))
        for (const join of joins)
          result = result.flatMap((entry) =>
            rows(join.table)
              .map((row) => ({
                row: entry.row,
                cells: { ...entry.cells, ...cells(join.table, row) }
              }))
              .filter((entry) => matches(join.condition, entry.cells))
          )
        return Promise.resolve(
          result
            .filter((entry) => matches(condition, entry.cells))
            .slice(0, limit)
            .map((entry) =>
              fields
                ? Object.fromEntries(
                    Object.entries(fields).map(([key, column]) => [
                      key,
                      entry.cells[getTableName(column.table)]?.[column.name]
                    ])
                  )
                : entry.row
            )
        ).then(resolve)
      }
    }
    return query
  }
  const db = {
    select,
    insert: (table: Table) => ({
      values: (input: Record<string, unknown> | Record<string, unknown>[]) => {
        let done = false
        const insert = (): Array<Record<string, unknown>> => {
          const inserted = (Array.isArray(input) ? input : [input]).map((row) => ({
            id: '00000000-0000-4000-8000-000000000099',
            builtIn: null,
            keycloakRoles: [],
            keycloakGroups: [],
            features: [],
            createdAt: new Date(),
            updatedAt: new Date(),
            ...row
          }))
          if (!done) {
            state.tables[getTableName(table)] ??= []
            state.tables[getTableName(table)]!.push(...inserted)
            done = true
          }
          return inserted
        }
        const query = {
          returning: async () => insert(),
          onConflictDoNothing: () => query,
          then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(insert()).then(resolve)
        }
        return query
      }
    }),
    delete: (table: Table) => ({
      where: async (condition: Condition) => {
        const deleted = rows(table).filter((row) => matches(condition, cells(table, row)))
        state.tables[getTableName(table)] = rows(table).filter((row) => !deleted.includes(row))
        if (getTableName(table) === 'dashboard_tile') {
          state.tables.dashboard_folder_item = state.tables.dashboard_folder_item!.filter(
            (item) => !deleted.some((row) => row.id === item.tileId)
          )
        }
      }
    }),
    update: (table: Table) => ({
      set: (values: Record<string, unknown>) => ({
        where: async (condition: Condition) => {
          for (const row of rows(table))
            if (matches(condition, cells(table, row))) Object.assign(row, values)
        }
      })
    }),
    transaction: async (run: (transaction: unknown) => Promise<unknown>) => {
      const before = structuredClone(state.tables)
      try {
        return await run(db)
      } catch (error) {
        state.tables = before
        throw error
      }
    }
  }
  return { db }
})

import { app } from './app.js'
import { runAdminCommand } from './admin-cli.js'

beforeEach(() => {
  state.actorId = 'alice'
  state.authenticated = true
  state.locked = []
  state.revokeActorOnLock = false
  state.tables = {
    user: ['alice', 'bob', 'carol'].map((id) => ({
      id,
      name: id === 'carol' ? 'Aaron' : id,
      email: `${id}@example.com`,
      image: null,
      language: null,
      username: null,
      givenName: null,
      familyName: null,
      keycloakRoles: [],
      keycloakGroups: [],
      createdAt: now,
      lastSignInAt: null
    })),
    app_role: [
      {
        id: customId,
        builtIn: null,
        name: 'Team',
        keycloakRoles: ['staff'],
        keycloakGroups: ['/team'],
        features: ['translator.compose'],
        createdAt: now,
        updatedAt: now
      },
      {
        id: adminId,
        builtIn: 'admin',
        name: 'Admin',
        keycloakRoles: [],
        keycloakGroups: [],
        features: [],
        createdAt: now,
        updatedAt: now
      },
      {
        id: everyoneId,
        builtIn: 'everyone',
        name: 'Alle Nutzenden',
        keycloakRoles: [],
        keycloakGroups: [],
        features: [...FEATURE_KEYS],
        createdAt: now,
        updatedAt: now
      }
    ],
    app_role_member: ['alice', 'bob'].map((userId) => ({
      roleId: adminId,
      userId,
      createdAt: now
    })),
    app_role_component: [{ roleId: everyoneId, componentId }],
    component: [componentId, hiddenId].map((id, sortOrder) => ({
      id,
      name: 'Link',
      nameTranslations: {},
      type: 'iframe',
      icon: null,
      iconUrl: null,
      config: { url: 'https://example.com' },
      enabled: true,
      singleton: false,
      sortOrder,
      createdAt: now,
      updatedAt: now
    })),
    sidebar_entry: [componentId, hiddenId].map((componentId, position) => ({
      userId: 'carol',
      componentId,
      position
    })),
    dashboard_tile: [componentId, hiddenId].map((componentId, x) => ({
      id: componentId,
      userId: 'carol',
      kind: 'widget',
      componentId,
      widgetKey: 'launcher',
      x: x * 4,
      y: 0,
      w: 4,
      h: 6
    })),
    dashboard_folder_item: [],
    folder_template: [
      {
        id: customId,
        name: 'Folder',
        icon: null,
        enabled: true,
        sortOrder: 0,
        createdAt: now,
        updatedAt: now
      }
    ],
    folder_template_item: [componentId, hiddenId].map((componentId, position) => ({
      templateId: customId,
      componentId,
      widgetKey: 'launcher',
      position
    }))
  }
})
const request = (method: string, path: string, body: unknown): Response | Promise<Response> =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
const patch = (id: string, roleIds: unknown): Response | Promise<Response> =>
  request('PATCH', `/api/admin/users/${id}`, { roleIds })
const roleInput = {
  name: 'Changed',
  keycloakRoles: [],
  keycloakGroups: [],
  componentIds: [componentId],
  features: ['translator.rephrase']
}

describe('admin user routes', () => {
  it('lists derived roles in contract order with ISO dates and matching memberships', async () => {
    state.tables.user![2]!.keycloakRoles = ['staff']
    const response = await app.request('/api/admin/users')
    expect(response.status).toBe(200)
    const { users } = adminUserListSchema.parse(await response.json())
    expect(users.map(({ id }) => id)).toEqual(['alice', 'bob', 'carol'])
    expect(users[0]).toMatchObject({
      role: 'admin',
      roleIds: [adminId],
      keycloakRoleIds: [],
      createdAt: now.toISOString(),
      lastSignInAt: null
    })
    expect(users[2]).toMatchObject({ role: 'user', roleIds: [], keycloakRoleIds: [customId] })
  })

  it('replaces manual roles under stable locks and ignores everyone', async () => {
    const response = await patch('bob', [customId, everyoneId])
    expect(response.status).toBe(200)
    expect(state.locked).toEqual(['app_role', 'user'])
    expect(await response.json()).toMatchObject({ id: 'bob', role: 'user', roleIds: [customId] })
  })

  it('rejects self-revocation, missing users and unknown roles without writes', async () => {
    expect((await patch('alice', [])).status).toBe(409)
    expect((await patch('unknown', [adminId])).status).toBe(404)
    expect((await patch('bob', [hiddenId])).status).toBe(400)
    expect(state.tables.app_role_member).toHaveLength(2)
  })

  it('allows removing a manual admin grant when Keycloak still grants admin', async () => {
    state.tables.app_role![1]!.keycloakRoles = ['staff']
    state.tables.user![0]!.keycloakRoles = ['staff']
    const response = await patch('alice', [])
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      role: 'admin',
      roleIds: [],
      keycloakRoleIds: [customId, adminId]
    })
  })

  it('validates malformed JSON and roleIds', async () => {
    const invalid = await patch('bob', ['owner'])
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({
      error: { code: 'validation', issues: [{ path: ['roleIds', 0] }] }
    })
    expect(
      (
        await app.request('/api/admin/users/bob', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: '{'
        })
      ).status
    ).toBe(400)
  })

  it('protects the last admin and rechecks a concurrently revoked actor', async () => {
    state.revokeActorOnLock = true
    expect((await patch('bob', [])).status).toBe(409)
    state.revokeActorOnLock = false
    state.tables.app_role_member = [{ roleId: adminId, userId: 'bob', createdAt: now }]
    expect((await patch('carol', [customId])).status).toBe(403)
  })

  it('requires effective admin access and authentication', async () => {
    state.actorId = 'carol'
    expect((await app.request('/api/admin/users')).status).toBe(403)
    expect((await patch('bob', [])).status).toBe(403)
    state.authenticated = false
    expect((await app.request('/api/admin/users')).status).toBe(401)
  })
})

describe('role routes', () => {
  it('lists built-ins first and manual member counts', async () => {
    const response = await app.request('/api/admin/roles')
    const { roles } = appRoleListSchema.parse(await response.json())
    expect(roles.map(({ id }) => id)).toEqual([everyoneId, adminId, customId])
    expect(roles.map(({ memberCount }) => memberCount)).toEqual([0, 2, 0])
  })

  it('creates, reads, replaces and deletes a custom role', async () => {
    const created = await request('POST', '/api/admin/roles', roleInput)
    expect(created.status).toBe(201)
    const role = appRoleSchema.parse(await created.json())
    expect((await app.request(`/api/admin/roles/${role.id}`)).status).toBe(200)
    const updated = await request('PUT', `/api/admin/roles/${role.id}`, {
      ...roleInput,
      name: 'Renamed',
      componentIds: []
    })
    expect(updated.status).toBe(200)
    expect(await updated.json()).toMatchObject({ name: 'Renamed', componentIds: [] })
    expect((await app.request(`/api/admin/roles/${role.id}`, { method: 'DELETE' })).status).toBe(
      204
    )
    expect((await app.request(`/api/admin/roles/${role.id}`)).status).toBe(404)
  })

  it('keeps built-in names, ignores everyone rules and refuses deleting built-ins', async () => {
    const updated = await request('PUT', `/api/admin/roles/${everyoneId}`, {
      ...roleInput,
      keycloakRoles: ['staff'],
      keycloakGroups: ['/team']
    })
    expect(updated.status).toBe(200)
    expect(await updated.json()).toMatchObject({
      name: 'Alle Nutzenden',
      keycloakRoles: [],
      keycloakGroups: [],
      memberCount: 0
    })
    for (const id of [everyoneId, adminId])
      expect((await app.request(`/api/admin/roles/${id}`, { method: 'DELETE' })).status).toBe(409)
  })

  it('ignores admin permission lists and preserves manual memberships on PUT', async () => {
    const updated = await request('PUT', `/api/admin/roles/${adminId}`, roleInput)
    expect(updated.status).toBe(200)
    expect(await updated.json()).toMatchObject({
      name: 'Admin',
      features: [],
      componentIds: [],
      memberCount: 2
    })
    expect(state.tables.app_role_member).toHaveLength(2)
  })

  it('refuses unknown components on POST and PUT, including ignored admin lists', async () => {
    for (const [method, path] of [
      ['POST', '/api/admin/roles'],
      ['PUT', `/api/admin/roles/${adminId}`]
    ]) {
      const response = await request(method!, path!, {
        ...roleInput,
        componentIds: ['00000000-0000-4000-8000-000000000098']
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: { code: 'validation' } })
    }
  })

  it('guards rule changes against self-lockout and removing the last effective admin', async () => {
    state.tables.app_role![1]!.keycloakRoles = ['staff']
    state.tables.user![0]!.keycloakRoles = ['staff']
    state.tables.app_role_member = [{ roleId: adminId, userId: 'bob', createdAt: now }]
    const self = await request('PUT', `/api/admin/roles/${adminId}`, roleInput)
    expect(self.status).toBe(409)
    expect(await self.json()).toMatchObject({
      error: { message: 'You cannot revoke your own admin role' }
    })
    state.tables.app_role_member = []
    const last = await request('PUT', `/api/admin/roles/${adminId}`, roleInput)
    expect(last.status).toBe(409)
    expect(await last.json()).toMatchObject({
      error: { message: 'At least one admin must remain' }
    })
  })

  it('lists the same distinct audiences as presets', async () => {
    state.tables.user![0]!.keycloakRoles = ['staff', 'staff']
    state.tables.user![1]!.keycloakGroups = ['/team']
    const roles = await app.request('/api/admin/roles/audiences')
    const presets = await app.request('/api/admin/presets/audiences')
    expect(await roles.json()).toEqual(await presets.json())
  })
})

describe('component access and me', () => {
  it('filters catalogues, folder templates, sidebar and dashboard for users', async () => {
    state.actorId = 'carol'
    expect(await (await app.request('/api/components')).json()).toMatchObject({
      components: [{ id: componentId }]
    })
    expect(
      componentListSchema.parse(await (await app.request('/api/components')).json()).components
    ).toHaveLength(1)
    expect(
      widgetListSchema
        .parse(await (await app.request('/api/widgets')).json())
        .widgets.every((widget: { componentId: string }) => widget.componentId === componentId)
    ).toBe(true)
    expect(await (await app.request('/api/sidebar')).json()).toEqual({
      componentIds: [componentId]
    })
    expect(
      dashboardSchema.parse(await (await app.request('/api/dashboard')).json()).tiles
    ).toHaveLength(1)
    expect(
      folderTemplateListSchema.parse(await (await app.request('/api/folder-templates')).json())
        .folders[0]!.widgets
    ).toEqual([{ componentId, widgetKey: 'launcher' }])
  })

  it('refuses adding inaccessible components to saved layouts', async () => {
    state.actorId = 'carol'
    expect((await request('PUT', '/api/sidebar', { componentIds: [hiddenId] })).status).toBe(400)
    expect(
      (
        await request('PUT', '/api/dashboard', {
          tiles: [
            {
              kind: 'widget',
              id: customId,
              componentId: hiddenId,
              widgetKey: 'launcher',
              x: 0,
              y: 0,
              w: 4,
              h: 6
            }
          ]
        })
      ).status
    ).toBe(400)
  })

  it('preserves hidden sidebar entries and widget tiles when saving visible layouts', async () => {
    state.actorId = 'carol'
    expect((await request('PUT', '/api/sidebar', { componentIds: [] })).status).toBe(200)
    expect(state.tables.sidebar_entry!.map((row) => row.componentId)).toEqual([hiddenId])
    expect((await request('PUT', '/api/dashboard', { tiles: [] })).status).toBe(200)
    expect(state.tables.dashboard_tile!.map((row) => row.componentId)).toEqual([hiddenId])
  })

  it('preserves inaccessible widgets inside a retained folder', async () => {
    state.actorId = 'carol'
    state.tables.dashboard_tile!.push({
      id: customId,
      userId: 'carol',
      kind: 'folder',
      title: 'Folder',
      icon: null,
      x: 0,
      y: 8,
      w: 4,
      h: 6
    })
    state.tables.dashboard_folder_item = [componentId, hiddenId].map((componentId, position) => ({
      id: componentId,
      tileId: customId,
      kind: 'widget',
      componentId,
      widgetKey: 'launcher',
      title: null,
      url: null,
      icon: null,
      position
    }))
    const response = await request('PUT', '/api/dashboard', {
      tiles: [
        {
          id: customId,
          kind: 'folder',
          title: 'Folder',
          icon: null,
          x: 0,
          y: 8,
          w: 4,
          h: 6,
          items: [{ kind: 'widget', componentId, widgetKey: 'launcher' }]
        }
      ]
    })
    expect(response.status).toBe(200)
    expect(state.tables.dashboard_folder_item!.map((row) => row.componentId)).toEqual([
      componentId,
      hiddenId
    ])
    state.tables.app_role_component!.push({ roleId: everyoneId, componentId: hiddenId })
    const dashboard = dashboardSchema.parse(await (await app.request('/api/dashboard')).json())
    const folder = dashboard.tiles.find((tile) => tile.kind === 'folder')
    expect(folder?.kind === 'folder' && folder.items).toHaveLength(2)
  })

  it('grants everyone access when an admin creates a component', async () => {
    const response = await request('POST', '/api/admin/components', {
      name: 'New link',
      nameTranslations: {},
      type: 'iframe',
      icon: null,
      iconUrl: null,
      config: { url: 'https://example.com' },
      enabled: true
    })
    expect(response.status).toBe(201)
    const created = componentListSchema.shape.components.element.parse(await response.json())
    expect(state.tables.app_role_component).toContainEqual(
      expect.objectContaining({ roleId: everyoneId, componentId: created.id })
    )
  })

  it.each(['GET', 'PATCH'])(
    'returns allowed components, including disabled ones, from %s me',
    async (method) => {
      state.tables.component![0]!.enabled = false
      state.tables.component![1]!.enabled = false
      const me = (): Response | Promise<Response> =>
        method === 'GET' ? app.request('/api/me') : request('PATCH', '/api/me', { language: 'en' })
      const admin = await me()
      expect(admin.status).toBe(200)
      expect(meSchema.parse(await admin.json())).toMatchObject({
        role: 'admin',
        features: [...FEATURE_KEYS],
        componentIds: [componentId, hiddenId],
        language: method === 'PATCH' ? 'en' : null
      })
      state.actorId = 'carol'
      state.tables.app_role![2]!.features = ['translator.documents']
      const reader = await me()
      expect(reader.status).toBe(200)
      expect(meSchema.parse(await reader.json())).toMatchObject({
        role: 'user',
        features: ['translator.documents'],
        componentIds: [componentId],
        language: method === 'PATCH' ? 'en' : null
      })
      state.tables.app_role_component = []
      expect(meSchema.parse(await (await me()).json()).componentIds).toEqual([])
    }
  )
})

describe('fresh live transcription access', () => {
  beforeEach(() => {
    state.tables.component![0]!.type = 'transcription'
  })

  it.each([
    'feature',
    'component grant',
    'disabled component',
    'deleted component',
    'deleted user'
  ])('detects a revoked %s after the socket opened', async (revoked) => {
    expect(await hasLiveAccess('carol', componentId)).toBe(true)
    switch (revoked) {
      case 'feature':
        state.tables.app_role![2]!.features = []
        break
      case 'component grant':
        state.tables.app_role_component = []
        break
      case 'disabled component':
        state.tables.component![0]!.enabled = false
        break
      case 'deleted component':
        state.tables.component = []
        break
      case 'deleted user':
        state.tables.user = []
        break
    }
    expect(await hasLiveAccess('carol', componentId)).toBe(false)
  })

  it('detects revocation of the manual admin role that granted live access', async () => {
    state.tables.app_role![2]!.features = []
    state.tables.app_role_component = []
    expect(await hasLiveAccess('alice', componentId)).toBe(true)
    state.tables.app_role_member = state.tables.app_role_member!.filter(
      (member) => member.userId !== 'alice'
    )
    expect(await hasLiveAccess('alice', componentId)).toBe(false)
  })

  it('detects revocation of the Keycloak rule that granted admin access', async () => {
    state.tables.app_role![2]!.features = []
    state.tables.app_role_component = []
    state.tables.app_role![1]!.keycloakRoles = ['staff']
    state.tables.user![2]!.keycloakRoles = ['staff']
    expect(await hasLiveAccess('carol', componentId)).toBe(true)
    state.tables.app_role![1]!.keycloakRoles = []
    expect(await hasLiveAccess('carol', componentId)).toBe(false)
  })
})

describe('admin CLI memberships', () => {
  it('grants and revokes manual admin membership and lists effective admins', async () => {
    expect(
      (await runAdminCommand({ command: 'grant', identifier: 'carol@example.com' }))[0]
    ).toMatchObject({ role: 'admin', roleIds: [adminId] })
    expect((await runAdminCommand({ command: 'list' })).map(({ id }) => id)).toEqual([
      'carol',
      'alice',
      'bob'
    ])
    expect((await runAdminCommand({ command: 'revoke', identifier: 'carol' }))[0]).toMatchObject({
      role: 'user',
      roleIds: []
    })
  })

  it('keeps Keycloak admin access when a manual grant is revoked', async () => {
    state.tables.app_role![1]!.keycloakRoles = ['staff']
    state.tables.user![0]!.keycloakRoles = ['staff']
    state.tables.app_role_member = [{ roleId: adminId, userId: 'alice', createdAt: now }]
    expect((await runAdminCommand({ command: 'revoke', identifier: 'alice' }))[0]).toMatchObject({
      role: 'admin',
      roleIds: [],
      keycloakRoleIds: [customId, adminId]
    })
  })

  it('protects the last admin and permits bootstrapping the first admin', async () => {
    state.tables.app_role_member = [{ roleId: adminId, userId: 'alice', createdAt: now }]
    await expect(runAdminCommand({ command: 'revoke', identifier: 'alice' })).rejects.toThrow(
      'At least one admin must remain'
    )
    state.tables.app_role_member = []
    expect((await runAdminCommand({ command: 'grant', identifier: 'bob' }))[0]!.role).toBe('admin')
    await expect(runAdminCommand({ command: 'grant', identifier: 'missing' })).rejects.toThrow(
      'The user must sign in first'
    )
  })
})
