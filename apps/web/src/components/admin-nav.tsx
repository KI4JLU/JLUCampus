import { Link } from '@tanstack/react-router'
import { FolderIcon, LayoutGridIcon, UserCogIcon, UsersIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'

const ICON = { 'aria-hidden': true, width: '1em', height: '1em' } as const

/** Looks like the design system's tabs, but each entry is a page: the active one is `aria-current`. */
const LINK_CLASS =
  '-mb-px flex shrink-0 items-center gap-2 border-b-2 border-transparent px-3 py-2 font-label-sm text-label-sm whitespace-nowrap text-on-surface-variant no-underline transition-colors hover:text-on-surface focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:outline-none focus-visible:ring-inset aria-[current=page]:border-primary aria-[current=page]:text-primary'

/**
 * Switches between the admin pages: the component catalogue, folder templates, presets and users.
 */
export function AdminNav(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <nav aria-label={t('admin.nav.label')}>
      <ul className="m-0 flex list-none items-center gap-1 overflow-x-auto overflow-y-hidden border-b border-outline-variant p-0">
        <li>
          <Link to="/admin/components" className={LINK_CLASS}>
            <LayoutGridIcon {...ICON} />
            {t('admin.nav.components')}
          </Link>
        </li>
        <li>
          <Link to="/admin/folders" className={LINK_CLASS}>
            <FolderIcon {...ICON} />
            {t('admin.nav.folders')}
          </Link>
        </li>
        <li>
          {/* Not exact, so it stays current in a preset's editor too. */}
          <Link to="/admin/presets" className={LINK_CLASS}>
            <UsersIcon {...ICON} />
            {t('admin.nav.presets')}
          </Link>
        </li>
        <li>
          <Link to="/admin/users" className={LINK_CLASS}>
            <UserCogIcon {...ICON} />
            {t('admin.nav.users')}
          </Link>
        </li>
      </ul>
    </nav>
  )
}
