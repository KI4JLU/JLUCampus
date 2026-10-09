import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@ki4jlu/design-system'
import type { AdminUser, AppRole } from '@justcampus/shared'
import { AdminUserDetails } from './admin-user-details'

interface UserDetailsDialogProps {
  /** The user to show; `null` closes the dialog. */
  user: AdminUser | null
  roles: readonly AppRole[] | undefined
  onAssignRoles: (opener: HTMLElement) => void
  onClose: () => void
  /** Where the focus goes as the dialog closes; see Radix' `onCloseAutoFocus`. */
  onCloseAutoFocus?: (event: Event) => void
}

/**
 * A user's details: name and e-mail as the title, then their roles with the way to assign them,
 * Keycloak roles and groups, sign-ins. The role dialog opens on top of it.
 */
export function UserDetailsDialog({
  user,
  roles,
  onAssignRoles,
  onClose,
  onCloseAutoFocus
}: UserDetailsDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Dialog open={user !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        closeLabel={t('common.close')}
        // DS gap: DialogContent has no height cap of its own; the details scroll in it.
        className="max-h-9/10 overflow-y-auto"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        {user ? (
          <>
            {/* DS gap: DialogHeader leaves no room for the close button; a long name would run
                under it. */}
            <DialogHeader className="pr-8">
              <DialogTitle className="wrap-anywhere">{user.name}</DialogTitle>
              <DialogDescription className="wrap-anywhere">{user.email}</DialogDescription>
            </DialogHeader>
            <AdminUserDetails user={user} roles={roles} onAssignRoles={onAssignRoles} />
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
