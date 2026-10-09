import { useTranslation } from 'react-i18next'
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@ki4jlu/design-system'
import type { AppRole } from '@justcampus/shared'
import { useDeleteRole } from '@/lib/queries'
import { toast } from '@/lib/toast'

interface DeleteRoleDialogProps {
  /** The custom role to delete; `null` closes the dialog. */
  role: AppRole | null
  onClose: () => void
  /** After the role is gone, e.g. to leave its editor. */
  onDeleted?: () => void
}

export function DeleteRoleDialog({
  role,
  onClose,
  onDeleted
}: DeleteRoleDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const remove = useDeleteRole()

  const confirm = (): void => {
    if (!role) return
    remove.mutate(role.id, {
      onSuccess: () => {
        toast({ variant: 'success', title: t('admin.roles.delete.done', { name: role.name }) })
        onClose()
        onDeleted?.()
      },
      onError: () => toast({ variant: 'error', title: t('admin.roles.delete.failed') })
    })
  }

  return (
    <Dialog open={role !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent closeLabel={t('common.close')}>
        <DialogHeader>
          <DialogTitle>{t('admin.roles.delete.title')}</DialogTitle>
          <DialogDescription>
            {t('admin.roles.delete.description', { name: role?.name ?? '' })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button variant="destructive" disabled={remove.isPending} onClick={confirm}>
            {t('common.delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
