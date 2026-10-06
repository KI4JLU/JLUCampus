import { useRef, useState } from 'react'
import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router'
import { EllipsisIcon, InfoIcon, SearchIcon, ShieldCheckIcon, ShieldOffIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Avatar,
  Button,
  Card,
  Container,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  ListToolbar,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@ki4jlu/design-system'
import type { AdminUser, UserRole } from '@justcampus/shared'
import { AdminGuard } from '@/components/admin-guard'
import { UserRoleBadge } from '@/components/admin-user-details'
import { PageHeader } from '@/components/page-header'
import { PageLoading } from '@/components/page-message'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { UserDetailsDialog } from '@/components/user-details-dialog'
import { UserRoleDialog, type RoleChange } from '@/components/user-role-dialog'
import { filterUsers, formatUserDate, userInitials } from '@/lib/admin-users'
import { adminUsersQuery, meQuery } from '@/lib/queries'

const route = getRouteApi('/app/admin/users')

const ICON = { 'aria-hidden': true, width: '1em', height: '1em' } as const

export function AdminUsersPage(): React.JSX.Element {
  return (
    <AdminGuard>
      <Users />
    </AdminGuard>
  )
}

/**
 * Everyone who ever signed in, admins first. A user's name, or "Details" in the menu at the end of
 * their row, shows them in a dialog; the menu and the dialog grant or revoke their admin role,
 * after a confirmation. The dialog's user is the `user` search param, so a reload keeps it.
 */
function Users(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const language = i18n.resolvedLanguage ?? i18n.language
  const navigate = useNavigate()
  const { user: selectedId } = route.useSearch()
  const { data: me } = useSuspenseQuery(meQuery)
  const { data: users, isPending, isError } = useQuery(adminUsersQuery)
  const [query, setQuery] = useState('')
  const [change, setChange] = useState<RoleChange | null>(null)
  // What opened each dialog, which gets the focus back as it closes.
  const detailsOpener = useRef<HTMLElement | null>(null)
  const roleOpener = useRef<HTMLElement | null>(null)
  const shown = filterUsers(users ?? [], query)
  const selected = users?.find((user) => user.id === selectedId) ?? null

  const showDetails = (user: AdminUser, opener: HTMLElement | null): void => {
    detailsOpener.current = opener
    void navigate({ to: '/admin/users', search: { user: user.id }, replace: true })
  }
  const changeRole = (user: AdminUser, role: UserRole, opener: HTMLElement | null): void => {
    roleOpener.current = opener
    setChange({ user, role })
  }

  return (
    <Container className="flex flex-col gap-gutter py-gutter md:py-margin-page">
      <PageHeader title={t('admin.users.title')} description={t('admin.users.description')} />
      <ListToolbar
        search={
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon {...ICON} />
            </InputGroupAddon>
            <InputGroupInput
              type="search"
              aria-label={t('admin.users.search')}
              placeholder={t('admin.users.searchPlaceholder')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </InputGroup>
        }
      />
      {users ? (
        <p className="sr-only" aria-live="polite">
          {t('admin.users.resultCount', { count: shown.length })}
        </p>
      ) : null}
      <Card>
        <div className="overflow-x-auto">
          {isPending ? (
            <PageLoading label={t('common.loading')} />
          ) : isError ? (
            <div className="p-4">
              <Alert variant="destructive">
                <AlertDescription>{t('admin.users.loadFailed')}</AlertDescription>
              </Alert>
            </div>
          ) : (
            <Table>
              <TableCaption className="sr-only">{t('admin.users.table.caption')}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('admin.table.name')}</TableHead>
                  <TableHead>{t('admin.users.table.email')}</TableHead>
                  <TableHead>{t('admin.users.table.role')}</TableHead>
                  <TableHead>{t('admin.users.table.lastSignIn')}</TableHead>
                  <TableHead className="text-right">{t('admin.table.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-8 text-center">
                      {users.length === 0
                        ? t('admin.users.table.empty')
                        : t('admin.users.table.noMatch', { query: query.trim() })}
                    </TableCell>
                  </TableRow>
                ) : (
                  shown.map((user) => (
                    <TableRow key={user.id}>
                      <TableCell className="whitespace-nowrap">
                        <span className="flex items-center gap-2">
                          {/* DS gap: Avatar shows initials only, not the user's picture. */}
                          <Avatar size="sm" initials={userInitials(user)} />
                          <Button variant="link" className="p-0" asChild>
                            <Link
                              to="/admin/users"
                              search={{ user: user.id }}
                              replace
                              onClick={(event) => {
                                detailsOpener.current = event.currentTarget
                              }}
                            >
                              {user.name}
                            </Link>
                          </Button>
                        </span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{user.email}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        <UserRoleBadge role={user.role} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {user.lastSignInAt ? (
                          <time dateTime={user.lastSignInAt}>
                            {formatUserDate(user.lastSignInAt, language)}
                          </time>
                        ) : (
                          t('admin.users.details.never')
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <div className="flex justify-end">
                          <UserActions
                            user={user}
                            isSelf={user.id === me.id}
                            onShowDetails={(opener) => showDetails(user, opener)}
                            onChangeRole={(role, opener) => changeRole(user, role, opener)}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </div>
      </Card>
      <UserDetailsDialog
        user={selected}
        isSelf={selected?.id === me.id}
        onChangeRole={(role, opener) => {
          if (selected) changeRole(selected, role, opener)
        }}
        onClose={() => void navigate({ to: '/admin/users', search: {}, replace: true })}
        onCloseAutoFocus={(event) => focusBack(event, detailsOpener.current)}
      />
      <UserRoleDialog
        change={change}
        onClose={() => setChange(null)}
        onCloseAutoFocus={(event) => focusBack(event, roleOpener.current)}
      />
    </Container>
  )
}

interface UserActionsProps {
  user: AdminUser
  /** The signed-in admin, who cannot revoke their own role (the details say why). */
  isSelf: boolean
  /** Both get the menu's button, which takes the focus back from the dialog they open. */
  onShowDetails: (opener: HTMLElement | null) => void
  onChangeRole: (role: UserRole, opener: HTMLElement | null) => void
}

/** The menu at the end of a user's row: their details, and granting or revoking the admin role. */
function UserActions({
  user,
  isSelf,
  onShowDetails,
  onChangeRole
}: UserActionsProps): React.JSX.Element {
  const { t } = useTranslation()
  const trigger = useRef<HTMLButtonElement>(null)
  const admin = user.role === 'admin'
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          ref={trigger}
          variant="ghost"
          size="icon"
          aria-label={t('admin.users.actions.menu', { name: user.name })}
        >
          <EllipsisIcon {...ICON} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onShowDetails(trigger.current)}>
          <InfoIcon {...ICON} />
          {t('admin.users.actions.details')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {admin ? (
          <DropdownMenuItem
            variant="destructive"
            disabled={isSelf}
            onSelect={() => onChangeRole('user', trigger.current)}
          >
            <ShieldOffIcon {...ICON} />
            {t('admin.users.role.revoke')}
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem onSelect={() => onChangeRole('admin', trigger.current)}>
            <ShieldCheckIcon {...ICON} />
            {t('admin.users.role.grant')}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Puts the focus back on what opened a dialog as it closes, which Radix only does for a
 * `DialogTrigger`. Without an opener (the dialog came with the page) Radix decides.
 */
function focusBack(event: Event, opener: HTMLElement | null): void {
  if (!opener?.isConnected) return
  event.preventDefault()
  opener.focus()
}
