import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { PlusIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Card,
  Container,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@ki4jlu/design-system'
import type { LayoutPreset } from '@justcampus/shared'
import { AdminGuard } from '@/components/admin-guard'
import { AdminPresetRow } from '@/components/admin-preset-row'
import { DeletePresetDialog } from '@/components/delete-preset-dialog'
import { PageHeader } from '@/components/page-header'
import { PageLoading } from '@/components/page-message'
import { PresetFormDialog } from '@/components/preset-form-dialog'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { movedPresetOrder, splitPresets } from '@/lib/presets'
import { adminPresetsQuery, useReorderLayoutPresets } from '@/lib/queries'
import { toast } from '@/lib/toast'

export function AdminPresetsPage(): React.JSX.Element {
  return (
    <AdminGuard>
      <Presets />
    </AdminGuard>
  )
}

/**
 * The starting sidebars and dashboards by Keycloak role or group, in match order, with the
 * `everyone` fallback pinned at the end.
 */
function Presets(): React.JSX.Element {
  const { t } = useTranslation()
  const { data: presets, isPending, isError } = useQuery(adminPresetsQuery)
  const reorder = useReorderLayoutPresets()
  const [creating, setCreating] = useState<number | null>(null)
  const [deleting, setDeleting] = useState<LayoutPreset | null>(null)
  const { ranked, fallback } = splitPresets(presets ?? [])

  const move = (index: number, offset: -1 | 1): void => {
    const ids = movedPresetOrder(presets ?? [], index, offset)
    if (!ids) return
    reorder.mutate(ids, {
      onError: () => toast({ variant: 'error', title: t('admin.table.reorderFailed') })
    })
  }

  return (
    <Container className="flex flex-col gap-gutter py-gutter md:py-margin-page">
      <PageHeader
        title={t('admin.presets.title')}
        description={t('admin.presets.description')}
        actions={
          <Button onClick={() => setCreating(Date.now())}>
            <PlusIcon aria-hidden="true" width="1em" height="1em" />
            {t('admin.presets.newPreset')}
          </Button>
        }
      />
      <Card>
        <div className="overflow-x-auto">
          {isPending ? (
            <PageLoading label={t('common.loading')} />
          ) : isError ? (
            <div className="p-4">
              <Alert variant="destructive">
                <AlertDescription>{t('admin.presets.loadFailed')}</AlertDescription>
              </Alert>
            </div>
          ) : (
            <Table>
              <TableCaption className="sr-only">{t('admin.presets.table.caption')}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('admin.presets.table.priority')}</TableHead>
                  <TableHead>{t('admin.table.name')}</TableHead>
                  <TableHead>{t('admin.presets.table.audience')}</TableHead>
                  <TableHead>{t('admin.presets.table.content')}</TableHead>
                  <TableHead className="text-right">{t('admin.table.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {presets.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-8 text-center text-on-surface-variant">
                      {t('admin.presets.table.empty')}
                    </TableCell>
                  </TableRow>
                ) : (
                  <>
                    {ranked.map((preset, index) => (
                      <AdminPresetRow
                        key={preset.id}
                        preset={preset}
                        rank={index + 1}
                        isFirst={index === 0}
                        isLast={index === ranked.length - 1}
                        onMove={(offset) => move(index, offset)}
                        onDelete={() => setDeleting(preset)}
                      />
                    ))}
                    {fallback ? (
                      <AdminPresetRow
                        preset={fallback}
                        rank={null}
                        isFirst={false}
                        isLast
                        onMove={() => undefined}
                        onDelete={() => setDeleting(fallback)}
                      />
                    ) : null}
                  </>
                )}
              </TableBody>
            </Table>
          )}
        </div>
      </Card>
      {creating === null ? null : (
        <PresetFormDialog
          key={creating}
          open
          onOpenChange={(open) => (open ? undefined : setCreating(null))}
          preset={null}
          fallbackTaken={fallback !== null}
        />
      )}
      <DeletePresetDialog preset={deleting} onClose={() => setDeleting(null)} />
    </Container>
  )
}
