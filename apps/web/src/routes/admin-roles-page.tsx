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
import type { AppRole } from '@justcampus/shared'
import { AdminGuard } from '@/components/admin-guard'
import { AdminRoleRow } from '@/components/admin-role-row'
import { DeleteRoleDialog } from '@/components/delete-role-dialog'
import { PageHeader } from '@/components/page-header'
import { PageLoading } from '@/components/page-message'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { adminRolesQuery } from '@/lib/queries'

export function AdminRolesPage(): React.JSX.Element {
  return (
    <AdminGuard>
      <Roles />
    </AdminGuard>
  )
}

/** The app's roles, the built-in ones (everyone, admin) first, then by name. */
function Roles(): React.JSX.Element {
  const { t } = useTranslation()
  const { data: roles, isPending, isError } = useQuery(adminRolesQuery)
  const [deleting, setDeleting] = useState<AppRole | null>(null)

  return (
    <Container className="flex flex-col gap-gutter py-gutter md:py-margin-page">
      <PageHeader
        title={t('admin.roles.title')}
        description={t('admin.roles.description')}
        actions={
          <Button asChild>
            <Link to="/admin/roles/new">
              <PlusIcon aria-hidden="true" width="1em" height="1em" />
              {t('admin.roles.newRole')}
            </Link>
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
                <AlertDescription>{t('admin.roles.loadFailed')}</AlertDescription>
              </Alert>
            </div>
          ) : (
            <Table>
              <TableCaption className="sr-only">{t('admin.roles.table.caption')}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('admin.table.name')}</TableHead>
                  <TableHead>{t('admin.roles.table.assignment')}</TableHead>
                  <TableHead>{t('admin.roles.table.members')}</TableHead>
                  <TableHead>{t('admin.roles.table.permissions')}</TableHead>
                  <TableHead className="text-right">{t('admin.table.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {roles.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-8 text-center">
                      {t('admin.roles.table.empty')}
                    </TableCell>
                  </TableRow>
                ) : (
                  roles.map((role) => (
                    <AdminRoleRow key={role.id} role={role} onDelete={() => setDeleting(role)} />
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </div>
      </Card>
      <DeleteRoleDialog role={deleting} onClose={() => setDeleting(null)} />
    </Container>
  )
}
