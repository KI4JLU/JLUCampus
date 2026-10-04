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
import type { AdminUser, UserRole } from '@justcampus/shared'
import { isRoleConflict } from '@/lib/admin-users'
import { useSetUserRole } from '@/lib/queries'
import { toast } from '@/lib/toast'

/** A user and the role they are to get. */
export interface RoleChange {
  user: AdminUser
  role: UserRole
}

interface UserRoleDialogProps {
  /** The change to confirm; `null` closes the dialog. */
  change: RoleChange | null
  onClose: () => void
  /** Where the focus goes as the dialog closes; see Radix' `onCloseAutoFocus`. */
  onCloseAutoFocus?: (event: Event) => void
}

/** Confirms granting or revoking the admin role, which opens or closes the admin area. */
export function UserRoleDialog({
  change,
  onClose,
  onCloseAutoFocus
}: UserRoleDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const setRole = useSetUserRole()
  const grant = change?.role === 'admin'
  const name = change?.user.name ?? ''

  const confirm = (): void => {
    if (!change) return
    setRole.mutate(
      { id: change.user.id, role: change.role },
      {
        onSuccess: (user) => {
          const done =
            user.role === 'admin' ? 'admin.users.role.granted' : 'admin.users.role.revoked'
          toast({ variant: 'success', title: t(done, { name: user.name }) })
          onClose()
        },
        onError: (error) =>
          toast({
            variant: 'error',
            title: t('admin.users.role.failed'),
            description: isRoleConflict(error) ? t('admin.users.role.conflict') : undefined
          })
      }
    )
  }

  return (
    <Dialog open={change !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent closeLabel={t('common.close')} onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>
            {grant ? t('admin.users.confirm.grantTitle') : t('admin.users.confirm.revokeTitle')}
          </DialogTitle>
          <DialogDescription>
            {grant
              ? t('admin.users.confirm.grantDescription', { name })
              : t('admin.users.confirm.revokeDescription', { name })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button
            variant={grant ? 'default' : 'destructive'}
            disabled={setRole.isPending}
            onClick={confirm}
          >
            {grant ? t('admin.users.confirm.grantAction') : t('admin.users.confirm.revokeAction')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
