import { FEATURE_KEYS } from '@justcampus/shared'
import { and, eq, inArray } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const databaseUrl = process.env.ROLES_TEST_DATABASE_URL
if (databaseUrl && !/^\/justcampus_roles_[a-z_]+$/.test(new URL(databaseUrl).pathname)) {
  throw new Error('Role integration tests require a dedicated justcampus_roles_* database')
}

vi.mock('./env.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./env.js')>()
  return {
    ...original,
    env: {
      ...original.env,
      DATABASE_URL: process.env.ROLES_TEST_DATABASE_URL ?? original.env.DATABASE_URL,
      SERVE_WEB_DIR: undefined
    }
  }
})
const state = vi.hoisted(() => ({ actorId: '' }))
vi.mock('./auth.js', () => ({
  auth: { handler: vi.fn() },
  getSession: async () => ({ user: { id: state.actorId } })
}))

import { ensureBuiltInRoles } from './access.js'
import { changeUserRoles, listAdminUsers } from './admin-users.js'
import { app } from './app.js'
import { client, db } from './db/index.js'
import {
  appRole,
  appRoleComponent,
  appRoleMember,
  component,
  dashboardFolderItem,
  dashboardTile,
  sidebarEntry,
  user
} from './db/schema.js'
import { ensureSingletonComponents } from './modules/index.js'

// Run against an already migrated disposable copy, never the shared development database.
describe.skipIf(!databaseUrl)('roles with Postgres', () => {
  const readerId = `roles-test-${randomUUID()}`
  const aliceId = `roles-test-${randomUUID()}`
  const bobId = `roles-test-${randomUUID()}`
  const visibleId = randomUUID()
  const hiddenId = randomUUID()
  const roleId = randomUUID()
  const hiddenTileId = randomUUID()
  const folderId = randomUUID()
  let adminRoleId: string

  beforeAll(async () => {
    await ensureBuiltInRoles()
    await ensureBuiltInRoles()
    await ensureSingletonComponents()
    const roles = await db.select().from(appRole)
    expect(roles.filter((role) => role.builtIn)).toHaveLength(2)
    adminRoleId = roles.find((role) => role.builtIn === 'admin')!.id
    const everyone = roles.find((role) => role.builtIn === 'everyone')!
    expect(everyone.features).toEqual(FEATURE_KEYS)
    const grants = await db
      .select()
      .from(appRoleComponent)
      .where(eq(appRoleComponent.roleId, everyone.id))
    const components = await db.select().from(component)
    expect(new Set(grants.map(({ componentId }) => componentId))).toEqual(
      new Set(components.map(({ id }) => id))
    )
    for (const id of [readerId, aliceId, bobId])
      await db.insert(user).values({ id, name: id, email: `${id}@example.test` })
    await db.insert(component).values(
      [visibleId, hiddenId].map((id) => ({
        id,
        name: 'Role test',
        type: 'iframe',
        config: { url: 'https://example.test' },
        sortOrder: 9999
      }))
    )
    await db.insert(appRole).values({ id: roleId, name: 'Role test' })
    await db.insert(appRoleComponent).values({ roleId, componentId: visibleId })
    await db.insert(appRoleMember).values([
      { roleId, userId: readerId },
      { roleId: adminRoleId, userId: aliceId },
      { roleId: adminRoleId, userId: bobId }
    ])
  })

  afterAll(async () => {
    await db.delete(user).where(inArray(user.id, [readerId, aliceId, bobId]))
    await db.delete(appRole).where(eq(appRole.id, roleId))
    await db.delete(component).where(inArray(component.id, [visibleId, hiddenId]))
    await client.end()
  })

  it('retains inaccessible sidebar entries, widget tiles and folder widgets', async () => {
    state.actorId = readerId
    await db.insert(sidebarEntry).values(
      [visibleId, hiddenId].map((componentId, position) => ({
        userId: readerId,
        componentId,
        position
      }))
    )
    await db.insert(dashboardTile).values([
      {
        id: hiddenTileId,
        userId: readerId,
        kind: 'widget',
        componentId: hiddenId,
        widgetKey: 'launcher',
        x: 8,
        y: 0,
        w: 4,
        h: 6
      },
      { id: folderId, userId: readerId, kind: 'folder', title: 'Folder', x: 0, y: 0, w: 4, h: 6 }
    ])
    await db.insert(dashboardFolderItem).values(
      [visibleId, hiddenId].map((componentId, position) => ({
        tileId: folderId,
        kind: 'widget',
        componentId,
        widgetKey: 'launcher',
        position
      }))
    )
    const put = (path: string, body: unknown): Response | Promise<Response> =>
      app.request(path, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
    expect((await put('/api/sidebar', { componentIds: [] })).status).toBe(200)
    expect(
      await db.select().from(sidebarEntry).where(eq(sidebarEntry.userId, readerId))
    ).toMatchObject([{ componentId: hiddenId }])
    expect(
      (
        await put('/api/dashboard', {
          tiles: [
            {
              id: folderId,
              kind: 'folder',
              title: 'Folder',
              icon: null,
              x: 0,
              y: 0,
              w: 4,
              h: 6,
              items: [{ kind: 'widget', componentId: visibleId, widgetKey: 'launcher' }]
            }
          ]
        })
      ).status
    ).toBe(200)
    expect(
      await db.select().from(dashboardTile).where(eq(dashboardTile.id, hiddenTileId))
    ).toHaveLength(1)
    expect(
      await db.select().from(dashboardFolderItem).where(eq(dashboardFolderItem.tileId, folderId))
    ).toHaveLength(2)
  })

  it('serializes simultaneous admin revocations and rechecks the second actor', async () => {
    const results = await Promise.allSettled([
      changeUserRoles(aliceId, bobId, []),
      changeUserRoles(bobId, aliceId, [])
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected')
    expect(rejected?.status).toBe('rejected')
    if (rejected?.status === 'rejected') expect([403, 409]).toContain(rejected.reason.status)
    const admins = (await listAdminUsers()).filter(
      (row) => row.role === 'admin' && [aliceId, bobId].includes(row.id)
    )
    expect(admins).toHaveLength(1)
    expect(
      await db
        .select()
        .from(appRoleMember)
        .where(
          and(
            eq(appRoleMember.roleId, adminRoleId),
            inArray(appRoleMember.userId, [aliceId, bobId])
          )
        )
    ).toHaveLength(1)
  })
})
