/** An admin page with its own row in the admin sidebar's "Verwaltung" group. */
export type AdminSection = 'components' | 'folders' | 'presets' | 'users'

const ADMIN_SECTIONS: readonly AdminSection[] = ['components', 'folders', 'presets', 'users']

/** The admin sidebar's current row: a section's, or a module's own. */
export type AdminNavEntry =
  { kind: 'section'; section: AdminSection } | { kind: 'module'; id: string }

/** Whether `pathname` lies in the admin area, where the sidebar shows the admin navigation. */
export function isAdminPath(pathname: string): boolean {
  return pathname === '/admin' || pathname.startsWith('/admin/')
}

function isAdminSection(value: string | undefined): value is AdminSection {
  return (ADMIN_SECTIONS as readonly (string | undefined)[]).includes(value)
}

/**
 * The admin sidebar's row for `pathname`. A section's row stays current on its sub-pages (a
 * preset's editor, a component's form), except on the form of a module, which has a row of its
 * own. `moduleIds` are the components with such a row.
 */
export function activeAdminEntry(
  pathname: string,
  moduleIds: ReadonlySet<string>
): AdminNavEntry | null {
  const [, area, section, id] = pathname.split('/')
  if (area !== 'admin' || !isAdminSection(section)) return null
  if (section === 'components' && id && moduleIds.has(id)) return { kind: 'module', id }
  return { kind: 'section', section }
}
