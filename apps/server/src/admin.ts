import { adminUsage, parseAdminArgs, runAdminCommand } from './admin-cli.js'

const args = parseAdminArgs(process.argv.slice(2))
if (!args) {
  console.error(adminUsage)
  process.exitCode = 2
} else {
  const { client } = await import('./db/index.js')
  try {
    const { readRoles } = await import('./access.js')
    const roles = await readRoles()
    const adminId = roles.find((role) => role.builtIn === 'admin')?.id
    for (const admin of await runAdminCommand(args)) {
      const sources = [
        adminId && admin.roleIds.includes(adminId) ? 'manual' : null,
        adminId && admin.keycloakRoleIds.includes(adminId) ? 'Keycloak' : null
      ].filter(Boolean)
      console.log(
        `${admin.email}\t${admin.name}\t${admin.id}\t${admin.role}\t${sources.join(' / ')}`
      )
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  } finally {
    await client.end()
  }
}
