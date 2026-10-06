import { useCallback, useId, useMemo, useRef, useState } from 'react'
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeftIcon, CloudOffIcon, PencilIcon, SearchXIcon, Trash2Icon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Container
} from '@ki4jlu/design-system'
import type { LayoutPreset, LayoutPresetInput } from '@justcampus/shared'
import { AdminGuard } from '@/components/admin-guard'
import { DashboardEditor } from '@/components/dashboard-editor'
import { DeletePresetDialog } from '@/components/delete-preset-dialog'
import { PageHeader } from '@/components/page-header'
import { PageLoading, PageMessage } from '@/components/page-message'
import { PresetFormDialog } from '@/components/preset-form-dialog'
import { SidebarArrangementEditor } from '@/components/sidebar-arrangement'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { ApiRequestError } from '@/lib/api'
import { audienceLabel } from '@/lib/presets'
import {
  adminPresetQuery,
  adminPresetsQuery,
  componentsQuery,
  folderTemplatesQuery,
  queryKeys,
  toLayoutPresetInput,
  useUpdateLayoutPreset,
  widgetsQuery
} from '@/lib/queries'
import { toast } from '@/lib/toast'
import { joinWidgets } from '@/lib/widgets'

const route = getRouteApi('/app/admin/presets/$presetId')
const ICON = { 'aria-hidden': true, width: '1em', height: '1em' } as const

export function AdminPresetEditorPage(): React.JSX.Element {
  const { presetId } = route.useParams()
  // Another preset starts over: no draft, dialog or pending save carries across.
  return (
    <AdminGuard>
      <PresetEditor key={presetId} presetId={presetId} />
    </AdminGuard>
  )
}

type PresetContent = Partial<Pick<LayoutPresetInput, 'sidebar' | 'dashboard'>>

/**
 * A preset's sidebar and dashboard in the same editors users have. Every change is saved on its
 * own: the sidebar at once, the dashboard shortly after the last move, like the user's own.
 */
function PresetEditor({ presetId }: { presetId: string }): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const client = useQueryClient()
  const preset = useQuery(adminPresetQuery(presetId))
  // Only to know whether another preset already is the fallback.
  const presets = useQuery(adminPresetsQuery)
  const components = useQuery(componentsQuery)
  const catalogue = useQuery(widgetsQuery)
  // Optional extra: without templates the dialog simply offers none.
  const templates = useQuery(folderTemplatesQuery)
  const { mutate } = useUpdateLayoutPreset()
  const [details, setDetails] = useState<number | null>(null)
  const [deleting, setDeleting] = useState<LayoutPreset | null>(null)
  const gone = useRef(false)
  const sidebarTitleId = useId()
  const dashboardTitleId = useId()

  const widgets = useMemo(
    () => joinWidgets(catalogue.data ?? [], components.data ?? []),
    [catalogue.data, components.data]
  )

  /**
   * Replaces the preset with `content` applied to its latest state in the cache, which takes
   * the change at once. So a sidebar save and a dashboard save in quick succession each carry
   * the other's change, and the saves (run in order) cannot undo one another.
   */
  const save = useCallback(
    (content: PresetContent, onSettled?: () => void): void => {
      const key = queryKeys.adminPreset(presetId)
      const current = client.getQueryData<LayoutPreset>(key)
      // A deleted preset has nothing left to save, not even the grid's last flush on the way out.
      if (!current || gone.current) return
      const input = { ...toLayoutPresetInput(current), ...content }
      client.setQueryData<LayoutPreset>(key, { ...current, ...input })
      mutate(
        { id: presetId, input },
        {
          onError: () => toast({ variant: 'error', title: t('admin.presets.editor.saveFailed') }),
          onSettled
        }
      )
    },
    [client, mutate, presetId, t]
  )
  const saveSidebar = useCallback(
    (componentIds: string[], onSettled?: () => void) =>
      save({ sidebar: { componentIds } }, onSettled),
    [save]
  )

  if (preset.isError) {
    const missing = preset.error instanceof ApiRequestError && preset.error.status === 404
    return (
      <PageMessage
        icon={missing ? <SearchXIcon /> : <CloudOffIcon />}
        title={missing ? t('admin.presets.editor.notFoundTitle') : t('admin.presets.loadFailed')}
        description={
          missing
            ? t('admin.presets.editor.notFoundDescription')
            : t('admin.presets.editor.loadFailedDescription')
        }
        actions={
          <Button asChild>
            <Link to="/admin/presets">{t('admin.presets.editor.back')}</Link>
          </Button>
        }
      />
    )
  }

  const data = preset.data
  const fallbackTaken = (presets.data ?? []).some(
    (entry) => entry.audience.kind === 'everyone' && entry.id !== presetId
  )
  const loading = components.isPending || catalogue.isPending
  const failed = components.isError || catalogue.isError
  const leave = (): void => {
    gone.current = true
    void navigate({ to: '/admin/presets' }).then(() =>
      client.removeQueries({ queryKey: queryKeys.adminPreset(presetId) })
    )
  }

  return (
    <Container className="flex flex-col gap-gutter py-gutter md:py-margin-page">
      <PageHeader
        title={data?.name ?? t('admin.presets.title')}
        description={
          data
            ? t('admin.presets.editor.description', { audience: audienceLabel(data.audience, t) })
            : undefined
        }
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to="/admin/presets">
                <ArrowLeftIcon {...ICON} />
                {t('admin.presets.editor.back')}
              </Link>
            </Button>
            {data ? (
              <>
                <Button variant="outline" onClick={() => setDetails(Date.now())}>
                  <PencilIcon {...ICON} />
                  {t('admin.presets.editor.details')}
                </Button>
                <Button variant="ghost-destructive" onClick={() => setDeleting(data)}>
                  <Trash2Icon {...ICON} />
                  {t('common.delete')}
                </Button>
              </>
            ) : null}
          </>
        }
      />
      {!data || loading ? (
        <PageLoading label={t('common.loading')} />
      ) : failed ? (
        <Alert variant="destructive">
          <AlertDescription>{t('admin.presets.editor.catalogueFailed')}</AlertDescription>
        </Alert>
      ) : (
        <>
          <section aria-labelledby={sidebarTitleId}>
            <Card>
              <CardHeader>
                <CardTitle asChild>
                  <h2 id={sidebarTitleId}>{t('admin.presets.editor.sidebarTitle')}</h2>
                </CardTitle>
                <CardDescription>{t('admin.presets.editor.sidebarDescription')}</CardDescription>
              </CardHeader>
              <CardContent>
                <SidebarArrangementEditor
                  catalogue={components.data}
                  componentIds={data.sidebar.componentIds}
                  loading={false}
                  failed={false}
                  onSave={saveSidebar}
                />
              </CardContent>
            </Card>
          </section>
          <section aria-labelledby={dashboardTitleId} className="flex flex-col gap-stack-md">
            <DashboardEditor
              tiles={data.dashboard.tiles}
              widgets={widgets}
              templates={templates.data ?? []}
              onSave={(tiles) => save({ dashboard: { tiles } })}
              empty={{
                title: t('admin.presets.editor.dashboardEmptyTitle'),
                description: t('admin.presets.editor.dashboardEmptyDescription')
              }}
              header={({ actions, editing }) => (
                <div className="flex flex-wrap items-start justify-between gap-stack-sm">
                  <div className="flex min-w-0 flex-col gap-1">
                    <h2 id={dashboardTitleId} className="m-0 text-lg font-semibold text-on-surface">
                      {t('admin.presets.editor.dashboardTitle')}
                    </h2>
                    <p className="m-0 text-sm text-on-surface-variant">
                      {editing
                        ? t('dashboard.editingHint')
                        : t('admin.presets.editor.dashboardDescription')}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-stack-sm">{actions}</div>
                </div>
              )}
            />
          </section>
        </>
      )}
      {details !== null && data ? (
        <PresetFormDialog
          key={details}
          open
          onOpenChange={(open) => (open ? undefined : setDetails(null))}
          preset={data}
          fallbackTaken={fallbackTaken}
        />
      ) : null}
      <DeletePresetDialog preset={deleting} onClose={() => setDeleting(null)} onDeleted={leave} />
    </Container>
  )
}
