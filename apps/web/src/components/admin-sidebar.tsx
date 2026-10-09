import { useId, useMemo, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowLeftIcon,
  FolderIcon,
  LayoutGridIcon,
  ShieldCheckIcon,
  UserCogIcon,
  UsersIcon,
  type LucideIcon
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Label, NavItem, useSidebarCollapsed } from '@ki4jlu/design-system'
import { isBuiltInType } from '@justcampus/shared'
import { activeAdminEntry, type AdminSection } from '@/lib/admin-nav'
import { useComponentName } from '@/lib/component-name'
import { adminComponentsQuery } from '@/lib/queries'
import { ComponentIcon } from './component-icon'

const icon = { 'aria-hidden': true, width: '1em', height: '1em' } as const

const SECTION_LINKS = [
  { section: 'components', to: '/admin/components', Icon: LayoutGridIcon },
  { section: 'folders', to: '/admin/folders', Icon: FolderIcon },
  { section: 'presets', to: '/admin/presets', Icon: UsersIcon },
  { section: 'roles', to: '/admin/roles', Icon: ShieldCheckIcon },
  { section: 'users', to: '/admin/users', Icon: UserCogIcon }
] as const satisfies readonly { section: AdminSection; to: string; Icon: LucideIcon }[]

/**
 * The sidebar's content in the admin area: the way back to the app, the admin pages, and the
 * built-in components (modules, desktop components), each linking to its settings. The modules
 * show once the catalogue has loaded; until then, or when it fails, their group is left out.
 */
export function AdminSidebar({ pathname }: { pathname: string }): React.JSX.Element {
  const { t } = useTranslation()
  const componentName = useComponentName()
  const { data: components } = useQuery(adminComponentsQuery)
  const modules = useMemo(
    () => (components ?? []).filter((component) => isBuiltInType(component.type)),
    [components]
  )
  const active = useMemo(
    () => activeAdminEntry(pathname, new Set(modules.map((module) => module.id))),
    [pathname, modules]
  )
  const back = t('admin.nav.back')

  return (
    <>
      <NavItem asChild label={back}>
        <Link to="/">
          <ArrowLeftIcon {...icon} />
          <span>{back}</span>
        </Link>
      </NavItem>
      <NavGroup title={t('admin.nav.manage')}>
        {SECTION_LINKS.map(({ section, to, Icon }) => {
          const label = t(`admin.nav.${section}`)
          return (
            <NavItem
              key={section}
              asChild
              label={label}
              active={active?.kind === 'section' && active.section === section}
            >
              <Link to={to}>
                <Icon {...icon} />
                <span className="truncate">{label}</span>
              </Link>
            </NavItem>
          )
        })}
      </NavGroup>
      {modules.length > 0 ? (
        <NavGroup title={t('admin.nav.modules')}>
          {modules.map((module) => (
            <NavItem
              key={module.id}
              asChild
              label={componentName(module)}
              active={active?.kind === 'module' && active.id === module.id}
            >
              <Link to="/admin/components/$componentId" params={{ componentId: module.id }}>
                <ComponentIcon icon={module.icon} iconUrl={module.iconUrl} />
                <span className="truncate">{componentName(module)}</span>
              </Link>
            </NavItem>
          ))}
        </NavGroup>
      ) : null}
    </>
  )
}

/**
 * Rows under a heading that names them as a group. The collapsed column has no room for the
 * heading; there only screen readers get it.
 * DS gap: no heading for a group of nav rows; `Label` gives it the label's look.
 */
function NavGroup({ title, children }: { title: string; children: ReactNode }): React.JSX.Element {
  const id = useId()
  const collapsed = useSidebarCollapsed()
  return (
    <div role="group" aria-labelledby={id} className="flex w-full flex-col gap-2">
      <Label asChild className={collapsed ? 'sr-only' : 'm-0 px-4 pt-2'}>
        <h2 id={id}>{title}</h2>
      </Label>
      {children}
    </div>
  )
}
