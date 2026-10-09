import { getRouteApi, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { CloudOffIcon, SearchXIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@ki4jlu/design-system'
import { AdminGuard } from '@/components/admin-guard'
import { PageLoading, PageMessage } from '@/components/page-message'
import { RoleEditor } from '@/components/role-editor'
import { ApiRequestError } from '@/lib/api'
import { adminRoleQuery } from '@/lib/queries'

const route = getRouteApi('/app/admin/roles/$roleId')

export function AdminNewRolePage(): React.JSX.Element {
  return (
    <AdminGuard>
      <RoleEditor role={null} />
    </AdminGuard>
  )
}

export function AdminRoleEditorPage(): React.JSX.Element {
  const { roleId } = route.useParams()
  // Another role starts over: no draft or pending save carries across.
  return (
    <AdminGuard>
      <EditRole key={roleId} roleId={roleId} />
    </AdminGuard>
  )
}

function EditRole({ roleId }: { roleId: string }): React.JSX.Element {
  const { t } = useTranslation()
  const role = useQuery(adminRoleQuery(roleId))

  if (role.isError) {
    // A malformed id in the address (`validation`) finds nothing either.
    const missing =
      role.error instanceof ApiRequestError &&
      (role.error.status === 404 || role.error.code === 'validation')
    return (
      <PageMessage
        icon={missing ? <SearchXIcon /> : <CloudOffIcon />}
        title={
          missing ? t('admin.roles.form.notFoundTitle') : t('admin.roles.form.loadFailedTitle')
        }
        description={
          missing
            ? t('admin.roles.form.notFoundDescription')
            : t('admin.roles.form.loadFailedDescription')
        }
        actions={
          <Button asChild>
            <Link to="/admin/roles">{t('admin.roles.form.back')}</Link>
          </Button>
        }
      />
    )
  }
  if (!role.data) return <PageLoading label={t('common.loading')} />
  return <RoleEditor role={role.data} />
}
