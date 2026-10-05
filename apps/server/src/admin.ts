import { asc, eq, or, sql } from 'drizzle-orm'

import { adminUsage, parseAdminArgs } from './admin-cli.js'

const args = parseAdminArgs(process.argv.slice(2))
if (!args) {
  console.error(adminUsage)
  process.exitCode = 2
} else {
  const { client, db } = await import('./db/index.js')
  const { user } = await import('./db/schema.js')
  try {
    if (args.command === 'list') {
      const admins = await db
        .select()
        .from(user)
        .where(eq(user.role, 'admin'))
        .orderBy(asc(sql`lower(${user.name})`), asc(user.id))
      for (const admin of admins) console.log(`${admin.email}\t${admin.name}\t${admin.id}`)
    } else {
      const role = args.command === 'grant' ? 'admin' : 'user'
      const [updated] = await db
        .update(user)
        .set({ role, updatedAt: new Date() })
        // Better-Auth creates the row at the first sign-in.
        .where(or(eq(user.id, args.identifier), eq(user.email, args.identifier)))
        .returning()
      if (!updated) {
        console.error(
          `No signed-in user found for "${args.identifier}". The user must sign in first.`
        )
        process.exitCode = 1
      } else {
        console.log(`${updated.email}\t${updated.name}\t${updated.id}\t${updated.role}`)
        const admins = await db
          .select({ id: user.id })
          .from(user)
          .where(eq(user.role, 'admin'))
          .limit(1)
        if (admins.length === 0)
          console.warn('Warning: no admin remains. Use admin grant to appoint one.')
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  } finally {
    await client.end()
  }
}
