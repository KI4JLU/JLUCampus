import { useState } from 'react'
import { Link } from '@tanstack/react-router'
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
import type { AdminComponent } from '@justcampus/shared'
import { AdminComponentRow } from '@/components/admin-component-row'
import { AdminGuard } from '@/components/admin-guard'
import { AdminNav } from '@/components/admin-nav'
import { DeleteComponentDialog } from '@/components/delete-component-dialog'
import { PageHeader } from '@/components/page-header'
import { PageLoading } from '@/components/page-message'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  adminComponentsQuery,
  toComponentInput,
  useReorderComponents,
  useUpdateComponent
} from '@/lib/queries'
import { toast } from '@/lib/toast'

export function AdminComponentsPage(): React.JSX.Element {
  return (
    <AdminGuard>
      <ComponentCatalogue />
    </AdminGuard>
  )
}

function ComponentCatalogue(): React.JSX.Element {
  const { t } = useTranslation()
  const { data: components, isPending, isError } = useQuery(adminComponentsQuery)
  const updateComponent = useUpdateComponent()
  const reorder = useReorderComponents()
  const [deleting, setDeleting] = useState<AdminComponent | null>(null)

  const toggle = (component: AdminComponent, enabled: boolean): void => {
    updateComponent.mutate(
      { id: component.id, input: { ...toComponentInput(component), enabled } },
      { onError: () => toast({ variant: 'error', title: t('admin.table.toggleFailed') }) }
    )
  }

  const move = (index: number, offset: -1 | 1): void => {
    if (!components) return
    const ids = components.map((component) => component.id)
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
        title={t('admin.title')}
        description={t('admin.description')}
        actions={
          <Button asChild>
            <Link to="/admin/components/new">
              <PlusIcon aria-hidden="true" width="1em" height="1em" />
              {t('admin.newComponent')}
            </Link>
          </Button>
        }
      />
      <AdminNav />
      <Card>
        <div className="overflow-x-auto">
          {isPending ? (
            <PageLoading label={t('common.loading')} />
          ) : isError ? (
            <div className="p-4">
              <Alert variant="destructive">
                <AlertDescription>{t('admin.loadFailed')}</AlertDescription>
              </Alert>
            </div>
          ) : (
            <Table>
              <TableCaption className="sr-only">{t('admin.table.caption')}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <span className="sr-only">{t('admin.table.icon')}</span>
                  </TableHead>
                  <TableHead>{t('admin.table.name')}</TableHead>
                  <TableHead>{t('admin.table.type')}</TableHead>
                  <TableHead>{t('admin.table.url')}</TableHead>
                  <TableHead>{t('admin.table.enabled')}</TableHead>
                  <TableHead className="text-right">{t('admin.table.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {components.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-8 text-center text-on-surface-variant">
                      {t('admin.table.empty')}
                    </TableCell>
                  </TableRow>
                ) : (
                  components.map((component, index) => (
                    <AdminComponentRow
                      key={component.id}
                      component={component}
                      isFirst={index === 0}
                      isLast={index === components.length - 1}
                      onToggle={(enabled) => toggle(component, enabled)}
                      onMove={(offset) => move(index, offset)}
                      onDelete={() => setDeleting(component)}
                    />
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </div>
      </Card>
      <DeleteComponentDialog component={deleting} onClose={() => setDeleting(null)} />
    </Container>
  )
}
