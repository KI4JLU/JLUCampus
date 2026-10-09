import { FEATURE_KEYS, type FeatureKey } from '@justcampus/shared'
import { asc, eq } from 'drizzle-orm'
import type { Context, MiddlewareHandler } from 'hono'

import { ApiError } from './api.js'
import { db } from './db/index.js'
import { appRole, appRoleComponent, appRoleMember, component, user } from './db/schema.js'
import { roleAccess, type AccessRole, type UserAccess } from './logic.js'
import type { AppEnvironment } from './modules/types.js'

export type AccessDatabase = Pick<typeof db, 'select' | 'insert' | 'delete' | 'update'>
export type RoleRow = typeof appRole.$inferSelect & AccessRole
export type Membership = typeof appRoleMember.$inferSelect

export async function readRoles(database: AccessDatabase = db, lock = false): Promise<RoleRow[]> {
  const query = database.select().from(appRole).orderBy(asc(appRole.id))
  const rows = await (lock ? query.for('update') : query)
  const grants = await database.select().from(appRoleComponent)
  return rows.map((role) => ({
    ...role,
    componentIds: grants
      .filter(({ roleId }) => roleId === role.id)
      .map(({ componentId }) => componentId)
  }))
}

export async function loadAccess(userId: string): Promise<UserAccess> {
  const [roles, members, users, components] = await Promise.all([
    readRoles(),
    db.select().from(appRoleMember).where(eq(appRoleMember.userId, userId)),
    db.select().from(user).where(eq(user.id, userId)).limit(1),
    db.select({ id: component.id }).from(component)
  ])
  if (!users[0]) throw new ApiError(401, 'unauthorized', 'Authentication required')
  return roleAccess(
    roles,
    members.map(({ roleId }) => roleId),
    users[0],
    components.map(({ id }) => id)
  )
}

/** Cache the promise too, so simultaneous consumers share one load in this request. */
export function getAccess(context: Context<AppEnvironment>): Promise<UserAccess> {
  let access = context.get('access')
  if (!access) {
    const session = context.get('session')
    if (!session) throw new ApiError(401, 'unauthorized', 'Authentication required')
    access = loadAccess(session.user.id)
    context.set('access', access)
  }
  return access
}

export function requireFeature(feature: FeatureKey): MiddlewareHandler<AppEnvironment> {
  return async (context, next) => {
    if (!(await getAccess(context)).features.has(feature)) {
      throw new ApiError(403, 'forbidden', 'Function permission required')
    }
    await next()
  }
}

export async function ensureBuiltInRoles(database: AccessDatabase = db): Promise<void> {
  await database
    .insert(appRole)
    .values([
      { builtIn: 'everyone', name: 'Alle Nutzenden', features: [...FEATURE_KEYS] },
      { builtIn: 'admin', name: 'Admin' }
    ])
    .onConflictDoNothing()
}

export async function grantEveryoneComponent(
  componentId: string,
  database: AccessDatabase = db
): Promise<void> {
  const [everyone] = await database.select().from(appRole).where(eq(appRole.builtIn, 'everyone'))
  if (!everyone) throw new Error('Built-in everyone role is missing')
  await database
    .insert(appRoleComponent)
    .values({ roleId: everyone.id, componentId })
    .onConflictDoNothing()
}
