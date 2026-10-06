import { getRouteApi, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { CloudOffIcon, SearchXIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@ki4jlu/design-system'
import { AdminGuard } from '@/components/admin-guard'
import { ComponentEditor } from '@/components/component-editor'
import { PageLoading, PageMessage } from '@/components/page-message'
import { ApiRequestError } from '@/lib/api'
import { adminComponentQuery } from '@/lib/queries'

const route = getRouteApi('/app/admin/components/$componentId')

export function AdminNewComponentPage(): React.JSX.Element {
  return (
    <AdminGuard>
      <ComponentEditor component={null} />
    </AdminGuard>
  )
}

export function AdminComponentEditorPage(): React.JSX.Element {
  const { componentId } = route.useParams()
  // Another component starts over: no draft or pending save carries across.
  return (
    <AdminGuard>
      <EditComponent key={componentId} componentId={componentId} />
    </AdminGuard>
  )
}

function EditComponent({ componentId }: { componentId: string }): React.JSX.Element {
  const { t } = useTranslation()
  const component = useQuery(adminComponentQuery(componentId))

  if (component.isError) {
    // A malformed id in the address (`validation`) finds nothing either.
    const missing =
      component.error instanceof ApiRequestError &&
      (component.error.status === 404 || component.error.code === 'validation')
    return (
      <PageMessage
        icon={missing ? <SearchXIcon /> : <CloudOffIcon />}
        title={missing ? t('admin.form.notFoundTitle') : t('admin.form.loadFailedTitle')}
        description={
          missing ? t('admin.form.notFoundDescription') : t('admin.form.loadFailedDescription')
        }
        actions={
          <Button asChild>
            <Link to="/admin/components">{t('admin.form.back')}</Link>
          </Button>
        }
      />
    )
  }
  if (!component.data) return <PageLoading label={t('common.loading')} />
  return <ComponentEditor component={component.data} />
}
