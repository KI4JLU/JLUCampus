import { Link } from '@tanstack/react-router'
import { EllipsisIcon, PencilIcon, Trash2Icon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  TableCell,
  TableRow
} from '@ki4jlu/design-system'
import type { AppRole } from '@justcampus/shared'
import { permissionSummary, roleName } from '@/lib/roles'

const ICON = { 'aria-hidden': true, width: '1em', height: '1em' } as const

interface AdminRoleRowProps {
  role: AppRole
  onDelete: () => void
}

/**
 * One role in the list: its name (leading to its editor), who gets it automatically, how many
 * an admin assigned it to by hand, what it allows, and a menu to edit or delete it. Built-in roles
 * cannot be deleted.
 */
export function AdminRoleRow({ role, onDelete }: AdminRoleRowProps): React.JSX.Element {
  const { t } = useTranslation()
  const name = roleName(role, t)
  return (
    <TableRow>
      <TableCell className="whitespace-nowrap">
        <span className="flex items-center gap-2">
          <Button variant="link" className="p-0" asChild>
            <Link to="/admin/roles/$roleId" params={{ roleId: role.id }}>
              {name}
            </Link>
          </Button>
          {role.builtIn ? (
            <Badge tone="secondary" appearance="filled">
              {t('admin.roles.builtInBadge')}
            </Badge>
          ) : null}
        </span>
      </TableCell>
      <TableCell>
        <RoleAssignment role={role} />
      </TableCell>
      <TableCell className="whitespace-nowrap">
        {role.builtIn === 'everyone'
          ? t('admin.roles.table.notApplicable')
          : t('admin.roles.table.memberCount', { count: role.memberCount })}
      </TableCell>
      <TableCell className="whitespace-nowrap">
        <RolePermissions role={role} />
      </TableCell>
      <TableCell className="whitespace-nowrap">
        <div className="flex justify-end">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('admin.roles.actions.menu', { name })}
              >
                <EllipsisIcon {...ICON} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link to="/admin/roles/$roleId" params={{ roleId: role.id }}>
                  <PencilIcon {...ICON} />
                  {t('admin.roles.actions.edit')}
                </Link>
              </DropdownMenuItem>
              {role.builtIn ? null : (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                    <Trash2Icon {...ICON} />
                    {t('common.delete')}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </TableCell>
    </TableRow>
  )
}

/** Who gets the role automatically: everyone, or the Keycloak roles and groups it names. */
function RoleAssignment({ role }: { role: AppRole }): React.JSX.Element {
  const { t } = useTranslation()
  if (role.builtIn === 'everyone') return <>{t('admin.roles.table.everyone')}</>
  const { keycloakRoles, keycloakGroups } = role
  if (keycloakRoles.length === 0 && keycloakGroups.length === 0) {
    return <>{t('admin.roles.table.manualOnly')}</>
  }
  return (
    <span className="flex flex-col gap-1">
      {keycloakRoles.length > 0 ? (
        <span>{t('admin.roles.table.keycloakRoles', { names: keycloakRoles.join(', ') })}</span>
      ) : null}
      {keycloakGroups.length > 0 ? (
        <span>{t('admin.roles.table.keycloakGroups', { names: keycloakGroups.join(', ') })}</span>
      ) : null}
    </span>
  )
}

/** "All permissions" for admins, else how many components and functions the role allows. */
function RolePermissions({ role }: { role: AppRole }): React.JSX.Element {
  const { t } = useTranslation()
  const summary = permissionSummary(role)
  switch (summary.kind) {
    case 'all':
      return (
        <Badge tone="primary" appearance="filled">
          {t('admin.roles.table.allPermissions')}
        </Badge>
      )
    case 'none':
      return <>{t('admin.roles.table.noPermissions')}</>
    case 'some':
      return (
        <>
          {t('admin.roles.table.permissionSummary', {
            components: t('admin.roles.table.componentCount', { count: summary.components }),
            features: t('admin.roles.table.featureCount', { count: summary.features })
          })}
        </>
      )
  }
}
