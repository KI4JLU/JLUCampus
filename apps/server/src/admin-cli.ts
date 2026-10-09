export type AdminCommand = { command: 'list' } | { command: 'grant' | 'revoke'; identifier: string }

export const adminUsage = 'Usage: admin grant <email|id> | revoke <email|id> | list'

export function parseAdminArgs(args: readonly string[]): AdminCommand | null {
  const [command, identifier] = args
  if (command === 'list' && args.length === 1) return { command }
  if ((command === 'grant' || command === 'revoke') && args.length === 2 && identifier?.trim()) {
    return { command, identifier }
  }
  return null
}

/** `grant` and `revoke` change manual membership; Keycloak membership stays effective. */
export async function runAdminCommand(
  args: AdminCommand
): Promise<import('@justcampus/shared').AdminUser[]> {
  const { db } = await import('./db/index.js')
  const { appRoleMember } = await import('./db/schema.js')
  const { and, eq } = await import('drizzle-orm')
  const { readRoleUsers, toAdminUser, orderAdminUsers, requireAdminContinuity } =
    await import('./admin-users.js')
  return db.transaction(async (transaction) => {
    const { roles, users, members } = await readRoleUsers(transaction, true)
    const admins = (): import('@justcampus/shared').AdminUser[] =>
      orderAdminUsers(users.map((row) => toAdminUser(row, roles, members))).filter(
        (row) => row.role === 'admin'
      )
    if (args.command === 'list') return admins()
    const target = users.find((row) => row.id === args.identifier || row.email === args.identifier)
    if (!target)
      throw new Error(
        `No signed-in user found for "${args.identifier}". The user must sign in first.`
      )
    const adminRole = roles.find((role) => role.builtIn === 'admin')
    if (!adminRole) throw new Error('Built-in admin role is missing. Run migrations first.')
    const nextMembers = members.filter(
      (member) => member.userId !== target.id || member.roleId !== adminRole.id
    )
    if (args.command === 'grant')
      nextMembers.push({ roleId: adminRole.id, userId: target.id, createdAt: new Date() })
    const after = users.map((row) => toAdminUser(row, roles, nextMembers))
    if (args.command === 'revoke') requireAdminContinuity(admins(), after)
    if (args.command === 'grant') {
      await transaction
        .insert(appRoleMember)
        .values({ roleId: adminRole.id, userId: target.id })
        .onConflictDoNothing()
    } else {
      await transaction
        .delete(appRoleMember)
        .where(and(eq(appRoleMember.roleId, adminRole.id), eq(appRoleMember.userId, target.id)))
    }
    return [after.find((row) => row.id === target.id)!]
  })
}
