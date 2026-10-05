import { ShieldCheckIcon, ShieldOffIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge, Button, PanelSection } from '@ki4jlu/design-system'
import type { AdminUser, UserRole } from '@justcampus/shared'
import { formatUserDate } from '@/lib/admin-users'

const ICON = { 'aria-hidden': true, width: '1em', height: '1em' } as const

/** The app's role as a badge; only admins stand out. */
export function UserRoleBadge({ role }: { role: UserRole }): React.JSX.Element {
  const { t } = useTranslation()
  return role === 'admin' ? (
    <Badge tone="primary">{t('admin.users.role.admin')}</Badge>
  ) : (
    <Badge appearance="text">{t('admin.users.role.user')}</Badge>
  )
}

interface AdminUserDetailsProps {
  user: AdminUser
  /** The signed-in admin, who cannot revoke their own role. */
  isSelf: boolean
  /** Asks to give the user this role; the page confirms it first and then focuses `opener`. */
  onChangeRole: (role: UserRole, opener: HTMLElement) => void
}

/** One user's details below their name: their role with its action, Keycloak, sign-ins. */
export function AdminUserDetails({
  user,
  isSelf,
  onChangeRole
}: AdminUserDetailsProps): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const language = i18n.resolvedLanguage ?? i18n.language
  const admin = user.role === 'admin'

  return (
    <div className="flex flex-col gap-stack-lg">
      <PanelSection
        title={t('admin.users.details.role')}
        aside={<UserRoleBadge role={user.role} />}
        hint={
          isSelf
            ? t('admin.users.role.selfHint')
            : admin
              ? t('admin.users.role.revokeHint')
              : t('admin.users.role.grantHint')
        }
      >
        <Button
          size="sm"
          variant={admin ? 'destructive-outline' : 'primary-outline'}
          className="self-start"
          disabled={admin && isSelf}
          onClick={(event) => onChangeRole(admin ? 'user' : 'admin', event.currentTarget)}
        >
          {admin ? <ShieldOffIcon {...ICON} /> : <ShieldCheckIcon {...ICON} />}
          {admin ? t('admin.users.role.revoke') : t('admin.users.role.grant')}
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
