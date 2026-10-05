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
import type { FolderTemplate } from '@justcampus/shared'
import { AdminFolderRow } from '@/components/admin-folder-row'
import { AdminGuard } from '@/components/admin-guard'
import { DeleteFolderTemplateDialog } from '@/components/delete-folder-template-dialog'
import { FolderTemplateFormDialog } from '@/components/folder-template-form-dialog'
import { PageHeader } from '@/components/page-header'
import { PageLoading } from '@/components/page-message'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  adminFolderTemplatesQuery,
  toFolderTemplateInput,
  useReorderFolderTemplates,
  useUpdateFolderTemplate
} from '@/lib/queries'
import { toast } from '@/lib/toast'

type FormTarget = { template: FolderTemplate | null; key: number } | null

export function AdminFoldersPage(): React.JSX.Element {
  return (
    <AdminGuard>
      <FolderTemplates />
    </AdminGuard>
  )
}

/** Folders admins predefine; users add a copy from the "add widget" dialog. */
function FolderTemplates(): React.JSX.Element {
  const { t } = useTranslation()
  const { data: templates, isPending, isError } = useQuery(adminFolderTemplatesQuery)
  const updateTemplate = useUpdateFolderTemplate()
  const reorder = useReorderFolderTemplates()
  const [form, setForm] = useState<FormTarget>(null)
  const [deleting, setDeleting] = useState<FolderTemplate | null>(null)

  const openForm = (template: FolderTemplate | null): void => setForm({ template, key: Date.now() })

  const toggle = (template: FolderTemplate, enabled: boolean): void => {
    updateTemplate.mutate(
      { id: template.id, input: { ...toFolderTemplateInput(template), enabled } },
      { onError: () => toast({ variant: 'error', title: t('admin.folders.table.toggleFailed') }) }
    )
  }

  const move = (index: number, offset: -1 | 1): void => {
    if (!templates) return
    const ids = templates.map((template) => template.id)
    const target = index + offset
    const moved = ids[index]
    const other = ids[target]
    if (moved === undefined || other === undefined) return
    ids[index] = other
    ids[target] = moved
    reorder.mutate(ids, {
      onError: () => toast({ variant: 'error', title: t('admin.table.reorderFailed') })
    })
  }

  return (
    <Container className="flex flex-col gap-gutter py-gutter md:py-margin-page">
      <PageHeader
        title={t('admin.folders.title')}
        description={t('admin.folders.description')}
        actions={
          <Button onClick={() => openForm(null)}>
            <PlusIcon aria-hidden="true" width="1em" height="1em" />
            {t('admin.folders.newFolder')}
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
                <AlertDescription>{t('admin.folders.loadFailed')}</AlertDescription>
              </Alert>
            </div>
          ) : (
            <Table>
              <TableCaption className="sr-only">{t('admin.folders.table.caption')}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <span className="sr-only">{t('admin.table.icon')}</span>
                  </TableHead>
                  <TableHead>{t('admin.table.name')}</TableHead>
                  <TableHead>{t('admin.folders.table.widgets')}</TableHead>
                  <TableHead>{t('admin.table.enabled')}</TableHead>
                  <TableHead className="text-right">{t('admin.table.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {templates.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-8 text-center text-on-surface-variant">
                      {t('admin.folders.table.empty')}
                    </TableCell>
                  </TableRow>
                ) : (
                  templates.map((template, index) => (
                    <AdminFolderRow
                      key={template.id}
                      template={template}
                      isFirst={index === 0}
                      isLast={index === templates.length - 1}
                      onToggle={(enabled) => toggle(template, enabled)}
                      onMove={(offset) => move(index, offset)}
                      onEdit={() => openForm(template)}
                      onDelete={() => setDeleting(template)}
                    />
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </div>
      </Card>
      {form ? (
        <FolderTemplateFormDialog
          key={form.key}
          open
          onOpenChange={(open) => (open ? undefined : setForm(null))}
          template={form.template}
        />
      ) : null}
      <DeleteFolderTemplateDialog template={deleting} onClose={() => setDeleting(null)} />
    </Container>
  )
}
