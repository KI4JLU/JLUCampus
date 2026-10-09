import { useMemo, useRef } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { DndContext } from '@dnd-kit/core'
import { ArrowUpRightIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { NavItem, PopoverAnchor, useSidebarCollapsed } from '@ki4jlu/design-system'
import type { Component } from '@justcampus/shared'
import { externalUrlOf, feedUrlOf, isAvailableHere } from '@/adapters/registry'
import { useComponentName } from '@/lib/component-name'
import { externalLinkProps } from '@/lib/external'
import { componentsQuery, sidebarQuery, useSaveSidebar } from '@/lib/queries'
import { keepHiddenIds } from '@/lib/sidebar-hidden'
import { toast } from '@/lib/toast'
import { componentTourId } from '@/lib/tour-targets'
import { useFeedHasUnread } from '@/lib/use-feed'
import { useMediaQuery } from '@/lib/use-media-query'
import { useSidebarArrangement } from '@/lib/use-sidebar-arrangement'
import { cn } from '@/lib/utils'
import { MoreAppsPanel } from './more-apps'
import { ComponentIcon } from './component-icon'
import { DropList, SidebarDragLayer, SidebarRows } from './sidebar-arrangement'

const icon = { 'aria-hidden': true, width: '1em', height: '1em' } as const

interface SidebarComponentsProps {
  /** The user's sidebar components, in their order. */
  components: Component[]
  pathname: string
  /** Whether "More apps" is open and the sidebar edited; the `Popover` around the shell holds that. */
  editing: boolean
}

/**
 * The component links of the sidebar, or while "More apps" is open their editor: the links turn
 * into sortable rows in place and the panel beside the column lists the other components; rows drag
 * between the two. `MoreAppsButton` opens and closes the panel.
 */
export function SidebarComponents({
  components,
  pathname,
  editing
}: SidebarComponentsProps): React.JSX.Element {
  if (editing) return <SidebarEditor pathname={pathname} />
  return (
    <>
      {components.map((component) => (
        <SidebarComponentLink key={component.id} component={component} pathname={pathname} />
      ))}
    </>
  )
}

interface SidebarComponentLinkProps {
  component: Component
  pathname: string
}

/**
 * A component's page inside the app, or for shortcut components their site outside it. The row
 * shrinks to its icon with the collapsed column; rows of components that show a feed flag its
 * unread entries.
 */
function SidebarComponentLink({
  component,
  pathname
}: SidebarComponentLinkProps): React.JSX.Element {
  const { t } = useTranslation()
  const name = useComponentName()(component)
  const url = externalUrlOf(component)
  const feedUrl = feedUrlOf(component)
  if (url) {
    return (
      <NavItem asChild label={name} data-tour={componentTourId(component.id)}>
        <a {...externalLinkProps(url)}>
          <ComponentIcon icon={component.icon} iconUrl={component.iconUrl} siteUrl={url} />
          <span className="truncate">{name}</span>
          <span className="sr-only">{t('shortcut.opensOutside')}</span>
          <ArrowUpRightIcon {...icon} className="ml-auto shrink-0 text-on-surface-variant" />
        </a>
      </NavItem>
    )
  }
  if (feedUrl) {
    return <FeedComponentLink component={component} pathname={pathname} feedUrl={feedUrl} />
  }
  return <ComponentPageLink component={component} pathname={pathname} unread={false} />
}

/** A feed component's row, flagged while its feed has unread entries. */
function FeedComponentLink({
  feedUrl,
  ...props
}: SidebarComponentLinkProps & { feedUrl: string }): React.JSX.Element {
  const unread = useFeedHasUnread(feedUrl)
  return <ComponentPageLink {...props} unread={unread} />
}

/**
 * The link to a component's page. `unread` adds a dot, beside the name or on the icon in the
 * collapsed column, and adds "new entries" to the link's name.
 */
function ComponentPageLink({
  component,
  pathname,
  unread
}: SidebarComponentLinkProps & { unread: boolean }): React.JSX.Element {
  const { t } = useTranslation()
  const name = useComponentName()(component)
  const collapsed = useSidebarCollapsed()
  const active = pathname === `/c/${component.id}`
  const unreadText = t('nav.newEntries')
  // Collapsed, the row's text is hidden and `label` is its name.
  const label = unread ? `${name} ${unreadText}` : name
  return (
    <NavItem
      asChild
      label={label}
      active={active}
      className={unread ? 'relative' : undefined}
      data-tour={componentTourId(component.id)}
    >
      <Link to="/c/$componentId" params={{ componentId: component.id }}>
        <ComponentIcon icon={component.icon} iconUrl={component.iconUrl} />
        <span className="truncate">{name}</span>
        {unread ? (
          <>
            <span className="sr-only"> {unreadText}</span>
            {/* An <svg>, so the collapsed row, which hides every other child, keeps it. */}
            <svg
              aria-hidden="true"
              viewBox="0 0 8 8"
              className={cn(
                'size-2 forced-colors:text-[CanvasText]',
                active ? 'text-on-primary' : 'text-primary',
                collapsed ? 'absolute top-2.5 left-1/2 ml-1.5' : 'ml-auto'
              )}
            >
              <circle cx="4" cy="4" r="4" fill="currentColor" />
            </svg>
          </>
        ) : null}
      </Link>
    </NavItem>
  )
}

/**
 * The user's own sidebar rows in place, plus the "More apps" panel, one drag context for both.
 * Changes are saved at once. The collapsed column has no room for the rows; it keeps its links
 * and the panel's buttons still add. Components this device cannot show (desktop components in
 * the browser) are left out of both lists but kept in the saved sidebar.
 */
function SidebarEditor({ pathname }: { pathname: string }): React.JSX.Element {
  const { t } = useTranslation()
  const collapsed = useSidebarCollapsed()
  const catalogue = useQuery(componentsQuery)
  const sidebar = useQuery(sidebarQuery)
  const { mutate } = useSaveSidebar()
  const wide = useMediaQuery('(min-width: 64rem)')
  const markerRef = useRef<HTMLSpanElement>(null)
  const { available, hiddenIds } = useMemo(() => {
    const all = catalogue.data ?? []
    return {
      available: catalogue.data?.filter(isAvailableHere),
      hiddenIds: new Set(all.filter((c) => !isAvailableHere(c)).map((c) => c.id))
    }
  }, [catalogue.data])
  const arrangement = useSidebarArrangement({
    catalogue: available,
    componentIds: sidebar.data,
    onSave: (componentIds, onSettled) =>
      mutate(keepHiddenIds(componentIds, sidebar.data ?? [], hiddenIds), {
        onError: () => toast({ variant: 'error', title: t('sidebarEditor.saveFailed') }),
        onSettled
      })
  })
  const { lists, listRef, byId } = arrangement

  // On wide screens the panel is a second column of full height beside the sidebar; on narrow
  // ones, where the column fills the screen, it sits below the rows.
  const anchor = useMemo(
    () => ({
      current: {
        getBoundingClientRect: (): DOMRect => {
          const column = markerRef.current?.closest('aside')?.getBoundingClientRect()
          if (!column) return new DOMRect(0, 0, 0, window.innerHeight)
          const rows = listRef.current?.getBoundingClientRect()
          if (wide || !rows) return column
          return new DOMRect(column.left, rows.top, column.width, rows.height)
        }
      }
    }),
    [listRef, wide]
  )

  const loading = catalogue.isPending || sidebar.isPending
  const failed = catalogue.isError || sidebar.isError

  return (
    <DndContext {...arrangement.dndProps}>
      <PopoverAnchor virtualRef={anchor} />
      <span ref={markerRef} hidden />
      {collapsed ? (
        lists.sidebar.flatMap((id) => {
          const component = byId.get(id)
          if (!component) return []
          return [<SidebarComponentLink key={id} component={component} pathname={pathname} />]
        })
      ) : (
        <DropList
          id="sidebar"
          listRef={listRef}
          label={t('sidebarEditor.sidebarLabel')}
          items={lists.sidebar}
          empty={loading ? t('common.loading') : t('sidebarEditor.sidebarEmpty')}
        >
          <SidebarRows arrangement={arrangement} list="sidebar" />
        </DropList>
      )}
      <MoreAppsPanel
        arrangement={arrangement}
        catalogue={available}
        loading={loading}
        failed={failed}
        wide={wide}
      />
      <SidebarDragLayer component={arrangement.activeComponent} />
    </DndContext>
  )
}
