import { adminUserSchema, type AdminUser } from '@justcampus/shared'
import { asc, eq } from 'drizzle-orm'

import { readRoles, type AccessDatabase, type Membership, type RoleRow } from './access.js'
import { ApiError } from './api.js'
import { db } from './db/index.js'
import { appRoleMember, user } from './db/schema.js'
import { heldRoles, keycloakRoleIds } from './logic.js'

type UserRow = typeof user.$inferSelect

export function toAdminUser(
  row: UserRow,
  roles: readonly RoleRow[],
  members: readonly Membership[]
): AdminUser {
  const roleIds = members
    .filter(
      (member) =>
        member.userId === row.id &&
        roles.some((role) => role.id === member.roleId && role.builtIn !== 'everyone')
    )
    .map(({ roleId }) => roleId)
  return adminUserSchema.parse({
    ...row,
    roleIds,
    keycloakRoleIds: keycloakRoleIds(roles, row),
    role: heldRoles(roles, roleIds, row).some((role) => role.builtIn === 'admin')
      ? 'admin'
      : 'user',
    createdAt: row.createdAt.toISOString(),
    lastSignInAt: row.lastSignInAt?.toISOString() ?? null
  })
}

export function orderAdminUsers<T extends { role: string; name: string; id: string }>(
  rows: readonly T[]
): T[] {
  return [...rows].sort(
    (left, right) =>
      Number(right.role === 'admin') - Number(left.role === 'admin') ||
      left.name.toLowerCase().localeCompare(right.name.toLowerCase()) ||
      left.id.localeCompare(right.id)
  )
}

/** All role mutations and CLI changes lock roles before users, in the same order. */
export async function readRoleUsers(
  database: AccessDatabase = db,
  lock = false
): Promise<{
  roles: RoleRow[]
  users: UserRow[]
  members: Membership[]
}> {
  const roles = await readRoles(database, lock)
  const query = database.select().from(user).orderBy(asc(user.id))
  const users = await (lock ? query.for('update') : query)
  const members = await database.select().from(appRoleMember)
  return { roles, users, members }
}

export function requireAdminContinuity(
  before: readonly AdminUser[],
  after: readonly AdminUser[],
  actorId?: string
): void {
  if (!after.some((row) => row.role === 'admin')) {
    throw new ApiError(409, 'conflict', 'At least one admin must remain')
  }
  if (actorId !== undefined) {
    if (!before.some((row) => row.id === actorId && row.role === 'admin')) {
      throw new ApiError(403, 'forbidden', 'Admin role required')
    }
    if (!after.some((row) => row.id === actorId && row.role === 'admin')) {
      throw new ApiError(409, 'conflict', 'You cannot revoke your own admin role')
    }
  }
}

export async function listAdminUsers(): Promise<AdminUser[]> {
  const { roles, users, members } = await readRoleUsers()
  return orderAdminUsers(users.map((row) => toAdminUser(row, roles, members)))
}

export async function changeUserRoles(
  actorId: string,
  targetId: string,
  roleIds: readonly string[]
): Promise<AdminUser> {
  return db.transaction(async (transaction) => {
    const { roles, users, members } = await readRoleUsers(transaction, true)
    if (!users.some((row) => row.id === targetId))
      throw new ApiError(404, 'not_found', 'User not found')
    if (roleIds.some((id) => !roles.some((role) => role.id === id))) {
      throw new ApiError(400, 'validation', 'Contains an unknown role id', [
        { path: ['roleIds'], message: 'Contains an unknown role id' }
      ])
    }
    const selected = roles.filter(
      (role) => role.builtIn !== 'everyone' && roleIds.includes(role.id)
    )
    const replacement = selected.map((role) => ({
      roleId: role.id,
      userId: targetId,
      createdAt: new Date()
    }))
    const nextMembers = [...members.filter((member) => member.userId !== targetId), ...replacement]
    const before = users.map((row) => toAdminUser(row, roles, members))
    const after = users.map((row) => toAdminUser(row, roles, nextMembers))
    requireAdminContinuity(before, after, actorId)
    await transaction.delete(appRoleMember).where(eq(appRoleMember.userId, targetId))
    if (replacement.length > 0) await transaction.insert(appRoleMember).values(replacement)
    return after.find((row) => row.id === targetId)!
  })
}
