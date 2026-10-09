import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Checkbox,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FormControl,
  FormDescription,
  FormItem,
  FormLabel,
  Spinner
} from '@ki4jlu/design-system'
import type { AdminUser, AppRole } from '@justcampus/shared'
import { isRoleConflict } from '@/lib/admin-users'
import { useSetUserRoles } from '@/lib/queries'
import { assignableRoles, roleName, withId } from '@/lib/roles'
import { toast } from '@/lib/toast'
import { Alert, AlertDescription } from './ui/alert'

interface UserRoleDialogProps {
  /** The user whose roles to assign; `null` closes the dialog. */
  user: AdminUser | null
  /** The app's roles; `undefined` while they load or when they failed (`rolesFailed`). */
  roles: readonly AppRole[] | undefined
  rolesFailed: boolean
  /** The signed-in admin, who cannot take their own admin role away. */
  isSelf: boolean
  onClose: () => void
  /** Where the focus goes as the dialog closes; see Radix' `onCloseAutoFocus`. */
  onCloseAutoFocus?: (event: Event) => void
}

/**
 * The roles an admin assigns a user by hand, a checkbox each; everyone's role, which everybody
 * holds, is not among them. Roles the user holds through Keycloak show checked and cannot be
 * cleared here.
 */
export function UserRoleDialog({
  user,
  roles,
  rolesFailed,
  isSelf,
  onClose,
  onCloseAutoFocus
}: UserRoleDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Dialog open={user !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        closeLabel={t('common.close')}
        // DS gap: DialogContent has no height cap of its own; a long role list scrolls in it.
        className="max-h-9/10 overflow-y-auto"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        {user ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('admin.users.assign.title')}</DialogTitle>
              <DialogDescription>
                {t('admin.users.assign.description', { name: user.name })}
              </DialogDescription>
            </DialogHeader>
            {rolesFailed ? (
              <Alert variant="destructive">
                <AlertDescription>{t('admin.users.assign.loadFailed')}</AlertDescription>
              </Alert>
            ) : !roles ? (
              <Spinner label={t('common.loading')} className="self-center" />
            ) : (
              // Remounted per user, so the checkboxes start from their roles.
              <RoleChoice
                key={user.id}
                user={user}
                roles={roles}
                isSelf={isSelf}
                onDone={onClose}
              />
            )}
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

interface RoleChoiceProps {
  user: AdminUser
  roles: readonly AppRole[]
  isSelf: boolean
  onDone: () => void
}

function RoleChoice({ user, roles, isSelf, onDone }: RoleChoiceProps): React.JSX.Element {
  const { t } = useTranslation()
  const setRoles = useSetUserRoles()
  const [roleIds, setRoleIds] = useState<string[]>(user.roleIds)
  const choices = assignableRoles(roles)

  const save = (): void => {
    setRoles.mutate(
      { id: user.id, patch: { roleIds } },
      {
        onSuccess: (saved) => {
          toast({ variant: 'success', title: t('admin.users.role.saved', { name: saved.name }) })
          onDone()
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
    <>
      {choices.length === 0 ? (
        <p className="m-0">{t('admin.users.assign.empty')}</p>
      ) : (
        <ul
          aria-label={t('admin.users.assign.roles')}
          className="m-0 grid list-none gap-stack-sm p-0"
        >
          {choices.map((role) => {
            const keycloak = user.keycloakRoleIds.includes(role.id)
            const manual = roleIds.includes(role.id)
            // Taking one's own admin role away would lock oneself out; the server refuses it too.
            const ownAdmin = isSelf && role.builtIn === 'admin' && manual && !keycloak
            const hint = keycloak
              ? t('admin.users.role.viaKeycloak')
              : ownAdmin
                ? t('admin.users.assign.selfAdminHint')
                : null
            return (
              <li key={role.id}>
                <FormItem className="flex-row items-start gap-3">
                  <FormControl>
                    <Checkbox
                      checked={keycloak || manual}
                      disabled={keycloak || ownAdmin}
                      onCheckedChange={(checked) =>
                        setRoleIds((current) => withId(current, role.id, checked === true))
                      }
                    />
                  </FormControl>
                  <div className="flex flex-col gap-1">
                    <FormLabel>{roleName(role, t)}</FormLabel>
                    {hint ? <FormDescription>{hint}</FormDescription> : null}
                  </div>
                </FormItem>
              </li>
            )
          })}
        </ul>
      )}
      <DialogFooter>
        <DialogClose asChild>
          <Button variant="secondary">{t('common.cancel')}</Button>
        </DialogClose>
        <Button disabled={setRoles.isPending || choices.length === 0} onClick={save}>
          {setRoles.isPending ? t('common.saving') : t('common.save')}
        </Button>
      </DialogFooter>
    </>
  )
}
