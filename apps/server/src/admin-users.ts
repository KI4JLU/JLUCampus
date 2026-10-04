import { adminUserSchema, type AdminUser } from '@justcampus/shared'
import { asc, eq, or } from 'drizzle-orm'

import { ApiError } from './api.js'
import { db } from './db/index.js'
import { user } from './db/schema.js'

export function toAdminUser(row: typeof user.$inferSelect): AdminUser {
  return adminUserSchema.parse({
    ...row,
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

export function requireRoleChange(
  rows: readonly { id: string; role: string }[],
  actorId: string,
  targetId: string,
  role: 'admin' | 'user'
): void {
  const target = rows.find((row) => row.id === targetId)
  if (!target) throw new ApiError(404, 'not_found', 'User not found')
  if (role === 'user' && target.role === 'admin') {
    if (actorId === targetId) {
      throw new ApiError(409, 'conflict', 'You cannot revoke your own admin role')
    }
    if (rows.filter((row) => row.role === 'admin').length <= 1) {
      throw new ApiError(409, 'conflict', 'At least one admin must remain')
    }
  }
  if (!rows.some((row) => row.id === actorId && row.role === 'admin')) {
    throw new ApiError(403, 'forbidden', 'Admin role required')
  }
}

export async function changeUserRole(
  actorId: string,
  targetId: string,
  role: 'admin' | 'user'
): Promise<AdminUser> {
  return db.transaction(async (transaction) => {
    // Lock the admins and the target in a stable order. Two admins revoking each other queue
    // here; the second then finds itself revoked.
    const rows = await transaction
      .select()
      .from(user)
      .where(or(eq(user.role, 'admin'), eq(user.id, targetId)))
      .orderBy(asc(user.id))
      .for('update')
    requireRoleChange(rows, actorId, targetId, role)
    const [updated] = await transaction
      .update(user)
      .set({ role, updatedAt: new Date() })
      .where(eq(user.id, targetId))
      .returning()
    return toAdminUser(updated!)
  })
}
