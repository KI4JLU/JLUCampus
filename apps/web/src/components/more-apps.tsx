import { useId, useMemo, useState } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, type SortingStrategy } from '@dnd-kit/sortable'
import { GripIcon, SearchIcon, XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Input,
  NavItem,
  PopoverClose,
  PopoverContent,
  PopoverTrigger
} from '@ki4jlu/design-system'
import type { Component } from '@justcampus/shared'
import { isInAnnouncementHint } from '@/lib/hint-layer'
import { TOUR } from '@/lib/tour-targets'
import type { SidebarArrangement } from '@/lib/use-sidebar-arrangement'
import { cn } from '@/lib/utils'
import { SidebarEditRow } from './sidebar-edit-row'

const icon = { 'aria-hidden': true, width: '1em', height: '1em' } as const

/**
 * Rows keep their places while one is dragged over the list: its order is the catalogue's, and
 * a row only joins the sidebar or comes back from it.
 */
const keepInPlace: SortingStrategy = () => null

/**
 * "More apps" at the foot of the column. It opens the panel of the components not in the sidebar
 * and, while it is open, turns the sidebar's links into sortable rows (see `SidebarComponents`).
 * A `Popover` around the shell holds the state; this is its trigger.
 */
export function MoreAppsButton(): React.JSX.Element {
  const { t } = useTranslation()
  const label = t('nav.moreApps')
  return (
    <PopoverTrigger asChild>
      <NavItem type="button" label={label} data-tour={TOUR.moreApps}>
        <GripIcon {...icon} />
        <span>{label}</span>
      </NavItem>
    </PopoverTrigger>
  )
}

interface MoreAppsPanelProps {
  arrangement: SidebarArrangement
  /** Every component, in the admins' order. */
  catalogue: Component[] | undefined
  loading: boolean
  failed: boolean
  /** A second column of full height beside the sidebar; else a panel below its rows. */
  wide: boolean
}

/**
 * The components not in the sidebar, with a search, as rows like the sidebar's while it is edited:
 * they drag into it or join it with their button, and open nothing. Rows dragged here from the
 * sidebar leave it.
 */
export function MoreAppsPanel({
  arrangement,
  catalogue,
  loading,
  failed,
  wide
}: MoreAppsPanelProps): React.JSX.Element {
  const { t } = useTranslation()
  const titleId = useId()
  const hintId = useId()
  const [search, setSearch] = useState('')
  const { lists, listRef, availableRef, activeId, add } = arrangement
  const label = t('nav.moreApps')

  // The sidebar of the moment, so a row dragged across leaves or joins this list at once.
  const matches = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    const inSidebar = new Set(lists.sidebar)
    return [...(catalogue ?? [])]
      .filter((c) => !inSidebar.has(c.id))
      .filter((c) => !query || c.name.toLocaleLowerCase().includes(query))
      .sort((a, b) => a.sortOrder - b.sortOrder)
  }, [catalogue, lists.sidebar, search])
  const { setNodeRef, isOver } = useDroppable({ id: 'available' })

  return (
    <PopoverContent
      side={wide ? 'right' : 'bottom'}
      align="start"
      sideOffset={wide ? 0 : 8}
      avoidCollisions={!wide}
      collisionPadding={12}
      aria-labelledby={titleId}
      aria-describedby={hintId}
      className={
        wide
          ? 'flex h-(--radix-popover-trigger-height) w-96 flex-col rounded-none border-y-0 border-l-0 p-0'
          : 'flex max-h-(--radix-popover-content-available-height) w-[min(24rem,calc(100vw-1.5rem))] flex-col p-0'
      }
      // Working in the sidebar rows is part of this, not a click away from it.
      // So is reading the hint dialog a click on "More apps" may have opened over it.
      onInteractOutside={(event) => {
        const inList = event.target instanceof Node && listRef.current?.contains(event.target)
        if (inList || isInAnnouncementHint(event.target)) event.preventDefault()
      }}
      // While a row is lifted by keyboard, Escape cancels that move and keeps the panel.
      onEscapeKeyDown={(event) => {
        if (activeId) event.preventDefault()
      }}
    >
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 id={titleId} className="m-0 text-base font-semibold text-on-surface">
            {label}
          </h2>
          <PopoverClose asChild>
            <Button variant="ghost" size="icon" aria-label={t('common.close')}>
              <XIcon {...icon} />
            </Button>
          </PopoverClose>
        </div>
        <p id={hintId} className="m-0 text-xs text-on-surface-variant">
          {t('moreApps.hint')}
        </p>
        <Input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('moreApps.search')}
          aria-label={t('moreApps.search')}
          leadingIcon={<SearchIcon aria-hidden="true" />}
          // The search, not the close button, is where the panel starts.
          autoFocus
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {loading ? (
          <p className="m-0 text-sm text-on-surface-variant">{t('common.loading')}</p>
        ) : failed ? (
          <p role="alert" className="m-0 text-sm text-error">
            {t('moreApps.loadFailed')}
          </p>
        ) : (
          <SortableContext id="available" items={matches.map((c) => c.id)} strategy={keepInPlace}>
            <ul
              ref={(node) => {
                setNodeRef(node)
                availableRef.current = node
              }}
              aria-label={label}
              className={cn(
                'm-0 flex min-h-12 list-none flex-col gap-2 rounded-[var(--ui-radius-control,var(--radius-action))] p-0 transition-colors',
                isOver && 'bg-secondary-container/40'
              )}
            >
              {matches.map((component) => (
                <SidebarEditRow
                  key={component.id}
                  component={component}
                  list="available"
                  onAction={() => add(component.id)}
                />
              ))}
            </ul>
          </SortableContext>
        )}
        {!loading && !failed && matches.length === 0 ? (
          <p className="m-0 text-sm text-on-surface-variant">
            {search.trim()
              ? t('moreApps.noMatches', { query: search.trim() })
              : catalogue?.length
                ? t('moreApps.allInSidebar')
                : t('moreApps.empty')}
          </p>
        ) : null}
        <p role="status" className="sr-only">
          {!loading && search.trim() ? t('moreApps.matches', { count: matches.length }) : ''}
        </p>
        <p role="status" className="sr-only">
          {arrangement.status}
        </p>
      </div>
    </PopoverContent>
  )
}
