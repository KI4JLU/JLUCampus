import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import { LayoutDashboardIcon, MenuIcon, PanelsTopLeftIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  AppShellLayout,
  Logo,
  NavItem,
  Popover,
  usePersistedWidth,
  useSidebarCollapsed,
  type MobilePaneTab
} from '@ki4jlu/design-system'
import type { Component, Me } from '@justcampus/shared'
import { isAdminPath } from '@/lib/admin-nav'
import { CollapseSidebarContext } from '@/lib/collapse-sidebar'
import { PageSidePanelContext } from '@/lib/page-side-panel'
import { TOUR } from '@/lib/tour-targets'
import { cn } from '@/lib/utils'
import { AccountMenu } from './account-menu'
import { AdminSidebar } from './admin-sidebar'
import { MoreAppsButton } from './more-apps'
import { SidebarComponents } from './sidebar-editor'

const LEFT_OPEN_KEY = 'justcampus.shell.left-open'
const LEFT_WIDTH_KEY = 'justcampus.shell.left-width'
const LEFT_WIDTH = { defaultWidth: 256, minWidth: 200, maxWidth: 420 }
const RIGHT_OPEN_KEY = 'justcampus.shell.right-open'
const RIGHT_WIDTH_KEY = 'justcampus.shell.right-width'
const RIGHT_WIDTH = { defaultWidth: 320, minWidth: 260, maxWidth: 480 }

type ShellTab = 'nav' | 'page'

interface AppFrameProps {
  me: Me
  /** The user's sidebar components, in their order. */
  sidebarComponents: Component[]
  children: ReactNode
}

/**
 * The chrome around every signed-in page: column with navigation and account, and one <main>
 * without a bar above it, so an embedded site keeps as much room as it can. Pages carry their own
 * title and actions (see `PageHeader`). A page can add a column on the right (see
 * `PageSidePanel`) and fold the navigation column while it is shown (see `useCollapsedSidebar`).
 * In the admin area the column holds the admin navigation instead.
 */
export function AppFrame({ me, sidebarComponents, children }: AppFrameProps): React.JSX.Element {
  const { t } = useTranslation()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  // "More apps" is open, and with it the sidebar's rows are being edited.
  const [moreAppsOpen, setMoreAppsOpen] = useState(false)
  // Others get the admin pages' "admins only" message under their own sidebar.
  const admin = me.role === 'admin' && isAdminPath(pathname)
  // The admin column has no sidebar rows to edit, so entering it (also by "back") closes the panel.
  if (admin && moreAppsOpen) setMoreAppsOpen(false)
  const [storedLeftOpen, setStoredLeftOpen] = useStoredOpen(LEFT_OPEN_KEY, true)
  // While a page folds the column (see `useCollapsedSidebar`), its state there is not stored, so
  // the user's own choice comes back on the next page.
  const [pageLeftOpen, setPageLeftOpen] = useState<boolean | null>(null)
  const leftOpen = pageLeftOpen ?? storedLeftOpen
  // The panel was placed against the open column, so collapsing the column closes it.
  const setLeftOpen = useCallback(
    (open: boolean) => {
      if (!open) setMoreAppsOpen(false)
      if (pageLeftOpen === null) setStoredLeftOpen(open)
      else setPageLeftOpen(open)
    },
    [pageLeftOpen, setStoredLeftOpen]
  )
  const holdLeftCollapsed = useCallback(() => {
    setMoreAppsOpen(false)
    setPageLeftOpen(false)
    return () => setPageLeftOpen(null)
  }, [])
  const [leftWidth, setLeftWidth] = usePersistedWidth(LEFT_WIDTH_KEY, LEFT_WIDTH)
  const [rightOpen, setRightOpen] = useStoredOpen(RIGHT_OPEN_KEY, true)
  const [rightWidth, setRightWidth] = usePersistedWidth(RIGHT_WIDTH_KEY, RIGHT_WIDTH)
  const [activeTab, setActiveTab] = useTabPerPath(pathname)
  const [sideLabel, setSideLabel] = useState<string | null>(null)
  const [sideSlot, setSideSlot] = useState<HTMLElement | null>(null)
  const sidePanel = useMemo(() => ({ element: sideSlot, setLabel: setSideLabel }), [sideSlot])

  const icon = { 'aria-hidden': true, width: '1em', height: '1em' } as const
  const mobileTabs: MobilePaneTab[] = [
    { id: 'nav', icon: <MenuIcon />, label: t('shell.tabNavigation'), pane: 'left' },
    { id: 'page', icon: <PanelsTopLeftIcon />, label: t('shell.tabPage'), pane: 'main' }
  ]

  const nav = admin ? (
    <AdminSidebar pathname={pathname} />
  ) : (
    <>
      <NavItem
        asChild
        label={t('nav.dashboard')}
        active={pathname === '/'}
        data-tour={TOUR.dashboardLink}
      >
        <Link to="/">
          <LayoutDashboardIcon {...icon} />
          <span>{t('nav.dashboard')}</span>
        </Link>
      </NavItem>
      <SidebarComponents
        components={sidebarComponents}
        pathname={pathname}
        editing={moreAppsOpen}
      />
    </>
  )

  return (
    // The "More apps" popover: its trigger sits in the column's footer, its panel and the sidebar
    // rows it edits in the nav, so the root holds both. It renders no element of its own.
    <Popover open={moreAppsOpen} onOpenChange={setMoreAppsOpen}>
      <AppShellLayout
        // DS gap: the template always renders its bar (a `<header>`, the first child of the main
        // column on wide screens, of the frame on narrow ones), and the app goes without it.
        className="[&>div>header]:hidden [&>header]:hidden"
        logo={<Logo product="Campus" size="sm" />}
        nav={nav}
        navLabel={admin ? t('admin.nav.label') : t('shell.navLabel')}
        sidebarFooter={<SidebarFooter me={me} admin={admin} />}
        rightPanel={
          sideLabel === null
            ? undefined
            : {
                label: sideLabel,
                header: <h2 className="truncate text-base font-semibold">{sideLabel}</h2>,
                content: <div ref={setSideSlot} className="p-4" />,
                isOpen: rightOpen,
                onOpenChange: setRightOpen,
                width: rightWidth,
                resize: {
                  minWidth: RIGHT_WIDTH.minWidth,
                  maxWidth: RIGHT_WIDTH.maxWidth,
                  onWidthChange: setRightWidth,
                  label: t('shell.resizeRight')
                },
                collapseLabel: t('shell.collapseRight'),
                expandLabel: t('shell.expandRight')
              }
        }
        leftOpen={leftOpen}
        onLeftOpenChange={setLeftOpen}
        collapseLabel={t('shell.collapse')}
        expandLabel={t('shell.expand')}
        leftWidth={leftWidth}
        leftResize={{
          minWidth: LEFT_WIDTH.minWidth,
          maxWidth: LEFT_WIDTH.maxWidth,
          onWidthChange: setLeftWidth,
          label: t('shell.resize')
        }}
        mobileTabs={mobileTabs}
        activeMobileTab={activeTab}
        onMobileTabChange={(id) => setActiveTab(id === 'nav' ? 'nav' : 'page')}
        mobileTabBarLabel={t('shell.tabsLabel')}
      >
        <div id="main-content" tabIndex={-1} className="flex min-h-0 flex-1 flex-col outline-none">
          <CollapseSidebarContext.Provider value={holdLeftCollapsed}>
            <PageSidePanelContext.Provider value={sidePanel}>
              {children}
            </PageSidePanelContext.Provider>
          </CollapseSidebarContext.Provider>
        </div>
      </AppShellLayout>
    </Popover>
  )
}

/** The foot of the column: "More apps", then the user's menu. The admin area has only the menu. */
function SidebarFooter({ me, admin }: { me: Me; admin: boolean }): React.JSX.Element {
  const collapsed = useSidebarCollapsed()
  return (
    <div className={cn('flex flex-col gap-2', collapsed && 'items-center')}>
      {admin ? null : <MoreAppsButton />}
      <AccountMenu me={me} />
    </div>
  )
}

/** Whether a column is open, remembered per device. */
function useStoredOpen(key: string, fallback: boolean): [boolean, (open: boolean) => void] {
  const [open, setOpenState] = useState<boolean>(() => {
    try {
      const stored = window.localStorage.getItem(key)
      return stored === null ? fallback : stored === 'true'
    } catch {
      return fallback
    }
  })
  const setOpen = useCallback(
    (next: boolean) => {
      setOpenState(next)
      try {
        window.localStorage.setItem(key, String(next))
      } catch {
        /* A lost preference costs nothing but the preference. */
      }
    },
    [key]
  )
  return [open, setOpen]
}

/** On a narrow screen, following a link from the navigation tab shows the page it opened. */
function useTabPerPath(pathname: string): [ShellTab, (tab: ShellTab) => void] {
  const [state, setState] = useState<{ tab: ShellTab; path: string }>({
    tab: 'page',
    path: pathname
  })
  const tab = state.path === pathname ? state.tab : 'page'
  const setTab = useCallback(
    (next: ShellTab) => setState({ tab: next, path: pathname }),
    [pathname]
  )
  return [tab, setTab]
}
