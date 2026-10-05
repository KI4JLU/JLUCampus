import type { AdminUser } from '@justcampus/shared'
import { ApiRequestError } from './api'

export interface AdminUsersSearch {
  /** The user whose details dialog is open. */
  user?: string
}

export function parseAdminUsersSearch(search: Record<string, unknown>): AdminUsersSearch {
  return typeof search.user === 'string' && search.user ? { user: search.user } : {}
}

/** Lower case without accents, so "muller" finds "Müller". */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase()
}

/** The users whose name or e-mail contain every word of the query, in their order. */
export function filterUsers<T extends Pick<AdminUser, 'name' | 'email'>>(
  users: readonly T[],
  query: string
): T[] {
  const terms = fold(query).split(/\s+/).filter(Boolean)
  if (terms.length === 0) return [...users]
  return users.filter((user) => {
    const text = fold(`${user.name} ${user.email}`)
    return terms.every((term) => text.includes(term))
  })
}

/** First letters of the first and last name, else of the e-mail address. */
export function userInitials(user: Pick<AdminUser, 'name' | 'email'>): string {
  const [first, ...rest] = user.name.trim().split(/\s+/).filter(Boolean)
  const letters = first ? `${first.charAt(0)}${rest.at(-1)?.charAt(0) ?? ''}` : user.email.charAt(0)
  return letters.toLocaleUpperCase()
}

/** A timestamp of the user list, with date and time in the given language. */
export function formatUserDate(iso: string, language: string): string {
  return new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso)
  )
}

/** The server's `conflict`: an admin revoking their own role, which would also leave none. */
export function isRoleConflict(error: unknown): boolean {
  return error instanceof ApiRequestError && error.code === 'conflict'
}
