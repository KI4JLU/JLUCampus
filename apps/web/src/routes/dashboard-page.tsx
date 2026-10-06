import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Container } from '@ki4jlu/design-system'
import { DashboardEditor } from '@/components/dashboard-editor'
import { PageLoading } from '@/components/page-message'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { i18n } from '@/i18n'
import {
  componentsQuery,
  dashboardQuery,
  folderTemplatesQuery,
  useSaveDashboard,
  widgetsQuery
} from '@/lib/queries'
import { toast } from '@/lib/toast'
import { joinWidgets } from '@/lib/widgets'

function notifySaveFailed(): void {
  toast({ variant: 'error', title: i18n.t('dashboard.saveFailed') })
}

export function DashboardPage(): React.JSX.Element {
  const { t } = useTranslation()
  const dashboard = useQuery(dashboardQuery)
  const components = useQuery(componentsQuery)
  const catalogue = useQuery(widgetsQuery)
  // Optional extra: without templates the dialog simply offers none.
  const templates = useQuery(folderTemplatesQuery)
  const { mutate: save } = useSaveDashboard(notifySaveFailed)

  const widgets = useMemo(
    () => joinWidgets(catalogue.data ?? [], components.data ?? []),
    [catalogue.data, components.data]
  )

  const loading = dashboard.isPending || components.isPending || catalogue.isPending
  const failed = dashboard.isError || components.isError || catalogue.isError

  // No visible title here: the heading is for assistive technology only.
  return (
    <Container className="flex flex-col gap-stack-lg py-gutter md:py-margin-page">
      <h1 className="sr-only">{t('dashboard.title')}</h1>
      {loading ? (
        <PageLoading label={t('common.loading')} />
      ) : failed ? (
        <Alert variant="destructive">
          <AlertDescription>{t('dashboard.loadFailed')}</AlertDescription>
        </Alert>
      ) : (
        <DashboardEditor
          tiles={dashboard.data ?? []}
          widgets={widgets}
          templates={templates.data ?? []}
          onSave={save}
          empty={{
            title: t('dashboard.emptyTitle'),
            description: t('dashboard.emptyDescription')
          }}
          header={({ actions, editing }) => (
            <div className="flex flex-wrap items-center justify-end gap-stack-sm">
              {editing ? (
                <p className="m-0 min-w-0 flex-1 basis-80 text-body-base text-on-surface-variant">
                  {t('dashboard.editingHint')}
                </p>
              ) : null}
              {actions}
            </div>
          )}
        />
      )}
    </Container>
  )
}
