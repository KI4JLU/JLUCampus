import { KeyRoundIcon, ShieldCheckIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Badge,
  Button,
  PanelSection,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '@ki4jlu/design-system'
import type { AdminUser, AppRole } from '@justcampus/shared'
import { formatUserDate } from '@/lib/admin-users'
import { roleName, userRoleEntries, type UserRoleEntry } from '@/lib/roles'

const ICON = { 'aria-hidden': true, width: '1em', height: '1em' } as const

interface UserRoleBadgesProps {
  user: AdminUser
  /** The app's roles; until they are known only admins stand out. */
  roles: readonly AppRole[] | undefined
}

/**
 * The user's roles as badges, admin first. Roles an admin assigned stand out; those that come
 * only through Keycloak are plain and carry a key. Who holds no role but everyone's gets its name.
 */
export function UserRoleBadges({ user, roles }: UserRoleBadgesProps): React.JSX.Element {
  const { t } = useTranslation()
  if (!roles) {
    return user.role === 'admin' ? (
      <Badge tone="primary">{t('admin.users.role.admin')}</Badge>
    ) : (
      <Badge appearance="text">{t('admin.users.role.user')}</Badge>
    )
  }
  const entries = userRoleEntries(user, roles)
  if (entries.length === 0) {
    return <Badge appearance="text">{t('admin.roles.builtIn.everyone')}</Badge>
  }
  return (
    <ul className="m-0 flex list-none flex-wrap items-center gap-1 p-0">
      {entries.map((entry) => (
        <li key={entry.role.id}>
          <RoleBadge entry={entry} />
        </li>
      ))}
    </ul>
  )
}

/** One role; "via Keycloak" as a tooltip on the key, and for screen readers in the text. */
function RoleBadge({ entry }: { entry: UserRoleEntry }): React.JSX.Element {
  const { t } = useTranslation()
  const tone = entry.role.builtIn === 'admin' ? 'primary' : 'neutral'
  const badge = (
    <Badge tone={tone} appearance={entry.manual ? 'filled' : 'text'}>
      {entry.keycloak ? <KeyRoundIcon {...ICON} /> : null}
      {roleName(entry.role, t)}
      {entry.keycloak ? (
        <span className="sr-only">{` (${t('admin.users.role.viaKeycloak')})`}</span>
      ) : null}
    </Badge>
  )
  if (!entry.keycloak) return badge
  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent>{t('admin.users.role.viaKeycloak')}</TooltipContent>
    </Tooltip>
  )
}

interface AdminUserDetailsProps {
  user: AdminUser
  roles: readonly AppRole[] | undefined
  /** Asks to assign the user's roles; the page opens the dialog and then focuses `opener`. */
  onAssignRoles: (opener: HTMLElement) => void
}

/** One user's details below their name: their roles with the way to assign them, Keycloak, sign-ins. */
export function AdminUserDetails({
  user,
  roles,
  onAssignRoles
}: AdminUserDetailsProps): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const language = i18n.resolvedLanguage ?? i18n.language

  return (
    <div className="flex flex-col gap-stack-lg">
      <PanelSection title={t('admin.users.details.role')} hint={t('admin.users.role.assignHint')}>
        <UserRoleBadges user={user} roles={roles} />
        <Button
          size="sm"
          variant="primary-outline"
          className="self-start"
          onClick={(event) => onAssignRoles(event.currentTarget)}
        >
          <ShieldCheckIcon {...ICON} />
          {t('admin.users.role.assign')}
        </Button>
      </PanelSection>

      <PanelSection
        title={t('admin.users.details.keycloakRoles')}
        hint={t('admin.users.details.keycloakHint')}
      >
        <NameList names={user.keycloakRoles} />
      </PanelSection>

      <PanelSection title={t('admin.users.details.keycloakGroups')}>
        <NameList names={user.keycloakGroups} />
      </PanelSection>

      <PanelSection title={t('admin.users.details.account')}>
        {/* DS gap: no description list; terms and values share the body type. */}
        <dl className="m-0 grid gap-stack-sm">
          <div>
            <dt>{t('admin.users.details.createdAt')}</dt>
            <dd className="m-0">
              <time dateTime={user.createdAt}>{formatUserDate(user.createdAt, language)}</time>
            </dd>
          </div>
          <div>
            <dt>{t('admin.users.details.lastSignIn')}</dt>
            <dd className="m-0">
              {user.lastSignInAt ? (
                <time dateTime={user.lastSignInAt}>
                  {formatUserDate(user.lastSignInAt, language)}
                </time>
              ) : (
                t('admin.users.details.never')
              )}
            </dd>
          </div>
        </dl>
      </PanelSection>
    </div>
  )
}

/** Keycloak role or group names as badges, or "none". */
function NameList({ names }: { names: readonly string[] }): React.JSX.Element {
  const { t } = useTranslation()
  if (names.length === 0) return <p className="m-0">{t('admin.users.details.none')}</p>
  return (
    <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
      {names.map((name) => (
        <li key={name}>
          <Badge>{name}</Badge>
        </li>
      ))}
    </ul>
  )
}
