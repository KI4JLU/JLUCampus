import { API, appRoleInputSchema, appRoleSchema, type AppRole } from '@justcampus/shared'
import { eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'

import { readRoles, type AccessDatabase, type Membership, type RoleRow } from './access.js'
import { readRoleUsers, requireAdminContinuity, toAdminUser } from './admin-users.js'
import { ApiError, parseBody, validationIssues } from './api.js'
import { db } from './db/index.js'
import { appRole, appRoleComponent, appRoleMember, component, user } from './db/schema.js'
import type { AppEnvironment } from './modules/types.js'

export function toAppRole(row: RoleRow, members: readonly Membership[]): AppRole {
  return appRoleSchema.parse({
    ...row,
    memberCount:
      row.builtIn === 'everyone' ? 0 : members.filter(({ roleId }) => roleId === row.id).length,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  })
}

function parseRoleId(value: string): string {
  const parsed = z.uuid().safeParse(value)
  if (!parsed.success)
    throw new ApiError(400, 'validation', 'Invalid role id', validationIssues(parsed.error))
  return parsed.data
}

async function requireComponents(ids: readonly string[], database: AccessDatabase): Promise<void> {
  if (ids.length === 0) return
  const rows = await database
    .select({ id: component.id })
    .from(component)
    .where(inArray(component.id, ids))
  if (rows.length !== ids.length)
    throw new ApiError(400, 'validation', 'Contains an unknown component id', [
      { path: ['componentIds'], message: 'Contains an unknown component id' }
    ])
}

async function replaceComponents(
  id: string,
  ids: readonly string[],
  database: AccessDatabase
): Promise<void> {
  await database.delete(appRoleComponent).where(eq(appRoleComponent.roleId, id))
  if (ids.length > 0)
    await database
      .insert(appRoleComponent)
      .values(ids.map((componentId) => ({ roleId: id, componentId })))
}

export function registerRoleRoutes(app: Hono<AppEnvironment>): void {
  app.get(API.adminRoles, async (context) => {
    const roles = await readRoles()
    const members = await db.select().from(appRoleMember)
    const rank = (role: RoleRow): number =>
      role.builtIn === 'everyone' ? 0 : role.builtIn === 'admin' ? 1 : 2
    roles.sort(
      (left, right) =>
        rank(left) - rank(right) ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id)
    )
    return context.json({ roles: roles.map((role) => toAppRole(role, members)) })
  })

  app.post(API.adminRoles, async (context) => {
    const input = await parseBody(context, appRoleInputSchema)
    const created = await db.transaction(async (transaction) => {
      await requireComponents(input.componentIds, transaction)
      const [role] = await transaction
        .insert(appRole)
        .values({
          name: input.name,
          keycloakRoles: input.keycloakRoles,
          keycloakGroups: input.keycloakGroups,
          features: input.features
        })
        .returning()
      await replaceComponents(role!.id, input.componentIds, transaction)
      return { ...role!, componentIds: input.componentIds }
    })
    return context.json(toAppRole(created, []), 201)
  })

  app.get(API.adminRoleAudiences, async (context) => {
    const rows = await db
      .select({ roles: user.keycloakRoles, groups: user.keycloakGroups })
      .from(user)
    return context.json({
      roles: [...new Set(rows.flatMap(({ roles }) => roles))].sort(),
      groups: [...new Set(rows.flatMap(({ groups }) => groups))].sort()
    })
  })

  app.get('/api/admin/roles/:id', async (context) => {
    const id = parseRoleId(context.req.param('id'))
    const roles = await readRoles()
    const role = roles.find((role) => role.id === id)
    if (!role) throw new ApiError(404, 'not_found', 'Role not found')
    const members = await db.select().from(appRoleMember).where(eq(appRoleMember.roleId, id))
    return context.json(toAppRole(role, members))
  })

  app.put('/api/admin/roles/:id', async (context) => {
    const id = parseRoleId(context.req.param('id'))
    const input = await parseBody(context, appRoleInputSchema)
    const updated = await db.transaction(async (transaction) => {
      const { roles, users, members } = await readRoleUsers(transaction, true)
      const role = roles.find((role) => role.id === id)
      if (!role) throw new ApiError(404, 'not_found', 'Role not found')
      await requireComponents(input.componentIds, transaction)
      const next = {
        ...role,
        name: role.builtIn ? role.name : input.name,
        keycloakRoles: role.builtIn === 'everyone' ? [] : input.keycloakRoles,
        keycloakGroups: role.builtIn === 'everyone' ? [] : input.keycloakGroups,
        componentIds: role.builtIn === 'admin' ? [] : input.componentIds,
        features: role.builtIn === 'admin' ? [] : input.features,
        updatedAt: new Date()
      }
      if (role.builtIn === 'admin') {
        const nextRoles = roles.map((row) => (row.id === id ? next : row))
        requireAdminContinuity(
          users.map((row) => toAdminUser(row, roles, members)),
          users.map((row) => toAdminUser(row, nextRoles, members)),
          context.get('session').user.id
        )
      }
      await transaction
        .update(appRole)
        .set({
          name: next.name,
          keycloakRoles: next.keycloakRoles,
          keycloakGroups: next.keycloakGroups,
          features: next.features,
          updatedAt: next.updatedAt
        })
        .where(eq(appRole.id, id))
      await replaceComponents(id, next.componentIds, transaction)
      return toAppRole(next, members)
    })
    return context.json(updated)
  })

  app.delete('/api/admin/roles/:id', async (context) => {
    const id = parseRoleId(context.req.param('id'))
    await db.transaction(async (transaction) => {
      const roles = await readRoles(transaction, true)
      const role = roles.find((role) => role.id === id)
      if (!role) throw new ApiError(404, 'not_found', 'Role not found')
      if (role.builtIn) throw new ApiError(409, 'conflict', 'Built-in roles cannot be deleted')
      await transaction.delete(appRole).where(eq(appRole.id, id))
    })
    return context.body(null, 204)
  })
}
