import {
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  type ParsedLocation
} from '@tanstack/react-router'
import { isUnauthorized } from '@/lib/api'
import { i18n, currentLanguage } from '@/i18n'
import { parseLoginSearch, safeRedirect, type LoginSearch } from '@/lib/redirect'
import { parseAdminUsersSearch, type AdminUsersSearch } from '@/lib/admin-users'
import { meQuery, queryClient, queryKeys, setUnauthorizedHandler } from '@/lib/queries'
import {
  AdminAnnouncementEditorPage,
  AdminNewAnnouncementPage
} from './admin-announcement-editor-page'
import { AdminAnnouncementsPage } from './admin-announcements-page'
import { AdminComponentEditorPage, AdminNewComponentPage } from './admin-component-editor-page'
import { AdminComponentsPage } from './admin-components-page'
import { AdminFoldersPage } from './admin-folders-page'
import { AdminPresetEditorPage } from './admin-preset-editor-page'
import { AdminPresetsPage } from './admin-presets-page'
import { AdminNewRolePage, AdminRoleEditorPage } from './admin-role-editor-page'
import { AdminRolesPage } from './admin-roles-page'
import { AdminUsersPage } from './admin-users-page'
import { AppErrorPage, NotFoundPage } from './error-pages'
import { AppLayout } from './app-layout'
import { ComponentPage } from './component-page'
import { DashboardPage } from './dashboard-page'
import { LoginPage } from './login-page'

async function requireSession({ location }: { location: ParsedLocation }): Promise<void> {
  try {
    const me = await queryClient.ensureQueryData(meQuery)
    if (me.language && me.language !== currentLanguage()) await i18n.changeLanguage(me.language)
  } catch (error) {
    if (isUnauthorized(error)) {
      throw redirect({ to: '/login', search: { redirect: location.href }, replace: true })
    }
    throw error
  }
}

const rootRoute = createRootRoute({
  component: Outlet,
  notFoundComponent: NotFoundPage
})

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: (search: Record<string, unknown>): LoginSearch => parseLoginSearch(search),
  beforeLoad: async ({ search }) => {
    const me = await queryClient.ensureQueryData(meQuery).catch(() => null)
    if (me) throw redirect({ href: safeRedirect(search.redirect), replace: true })
  },
  component: LoginPage
})

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  beforeLoad: requireSession,
  component: AppLayout,
  errorComponent: AppErrorPage
})

const dashboardRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  component: DashboardPage
})

const componentRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/c/$componentId',
  component: ComponentPage
})

const adminComponentsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/admin/components',
  component: AdminComponentsPage
})

const adminNewComponentRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/admin/components/new',
  component: AdminNewComponentPage
})

const adminComponentRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/admin/components/$componentId',
  component: AdminComponentEditorPage
})

const adminFoldersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/admin/folders',
  component: AdminFoldersPage
})

const adminPresetsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/admin/presets',
  component: AdminPresetsPage
})

const adminPresetRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/admin/presets/$presetId',
  component: AdminPresetEditorPage
})

const adminRolesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/admin/roles',
  component: AdminRolesPage
})

const adminNewRoleRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/admin/roles/new',
  component: AdminNewRolePage
})

const adminRoleRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/admin/roles/$roleId',
  component: AdminRoleEditorPage
})

const adminUsersRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/admin/users',
  validateSearch: (search: Record<string, unknown>): AdminUsersSearch =>
    parseAdminUsersSearch(search),
  component: AdminUsersPage
})

const adminAnnouncementsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/admin/announcements',
  component: AdminAnnouncementsPage
})

const adminNewAnnouncementRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/admin/announcements/new',
  component: AdminNewAnnouncementPage
})

const adminAnnouncementRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/admin/announcements/$announcementId',
  component: AdminAnnouncementEditorPage
})

const routeTree = rootRoute.addChildren([
  loginRoute,
  appRoute.addChildren([
    dashboardRoute,
    componentRoute,
    adminComponentsRoute,
    adminNewComponentRoute,
    adminComponentRoute,
    adminFoldersRoute,
    adminPresetsRoute,
    adminPresetRoute,
    adminRolesRoute,
    adminNewRoleRoute,
    adminRoleRoute,
    adminUsersRoute,
    adminAnnouncementsRoute,
    adminNewAnnouncementRoute,
    adminAnnouncementRoute
  ])
])

export const router = createRouter({
  routeTree,
  history: createBrowserHistory(),
  defaultPreload: false
})

// A session that ends while the app is open (expired, signed out elsewhere) lands on the login page.
setUnauthorizedHandler(() => {
  if (!queryClient.getQueryData(queryKeys.me)) return
  const { href, pathname } = router.state.location
  queryClient.clear()
  if (pathname !== '/login') {
    void router.navigate({ to: '/login', search: { redirect: href }, replace: true })
  }
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
