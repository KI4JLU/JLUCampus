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
