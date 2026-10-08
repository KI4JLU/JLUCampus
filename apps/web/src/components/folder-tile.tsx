import { useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link } from '@tanstack/react-router'
import { ArrowUpRightIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  widgetRefKey,
  type FolderItem,
  type FolderTile as FolderTileData
} from '@justcampus/shared'
import { externalUrlOf } from '@/adapters/registry'
import { useComponentName } from '@/lib/component-name'
import { folderItemKey } from '@/lib/dashboard'
import { externalLinkProps } from '@/lib/external'
import { cn } from '@/lib/utils'
import type { ComponentWidget } from '@/lib/widgets'
import { ComponentIcon } from './component-icon'
import { FolderTitleIcon } from './folder-title-icon'
import { SiteIcon } from './site-icon'

export interface Point {
  x: number
  y: number
}

interface FolderTileProps {
  tile: FolderTileData
  /** Every widget of every enabled component, by `widgetRefKey`. */
  widgetsByKey: ReadonlyMap<string, ComponentWidget>
  /** In edit mode the mini tiles are drag sources instead of links. */
  editing: boolean
  /** The pointer moved while an entry is dragged out; `null` when the drag ends. */
  onItemDrag?: (point: Point | null) => void
  onItemDrop?: (item: FolderItem, point: Point) => void
}

/** A folder entry ready to show: where it leads and how it looks. */
interface Entry {
  key: string
  item: FolderItem
  name: string
  icon: ReactNode
  /** Shortcuts open outside the app; other widgets open their component's page. */
  target: { kind: 'page'; componentId: string } | { kind: 'external'; url: string }
}

function toEntry(
  item: FolderItem,
  widgetsByKey: ReadonlyMap<string, ComponentWidget>,
  componentName: (component: ComponentWidget['component']) => string
): Entry | null {
  const key = folderItemKey(item)
  if (item.kind === 'link') {
    return {
      key,
      item,
      name: item.title,
      icon: <SiteIcon url={item.url} icon={item.icon} />,
      target: { kind: 'external', url: item.url }
    }
  }
  const component = widgetsByKey.get(widgetRefKey(item))?.component
  if (!component) return null
  const url = externalUrlOf(component)
  return {
    key,
    item,
    name: componentName(component),
    icon: <ComponentIcon icon={component.icon} iconUrl={component.iconUrl} siteUrl={url} />,
    target: url ? { kind: 'external', url } : { kind: 'page', componentId: component.id }
  }
}

/** Pixels the pointer must travel before a press becomes a drag. */
const DRAG_THRESHOLD = 4

const ENTRY_CLASS =
  'relative flex flex-col items-center gap-1.5 rounded-lg p-2 text-center text-on-surface no-underline transition-colors hover:bg-surface-container focus-visible:bg-surface-container'

/**
 * A folder shows its name and its widgets and shortcuts as small tiles:
 * widgets open their component's page, shortcuts open outside the app.
 */
export function FolderTile({
  tile,
  widgetsByKey,
  editing,
  onItemDrag,
  onItemDrop
}: FolderTileProps): React.JSX.Element {
  const { t } = useTranslation()
  const componentName = useComponentName()
  const entries = tile.items.flatMap((item) => toEntry(item, widgetsByKey, componentName) ?? [])
  const [ghost, setGhost] = useState<{ entry: Entry; point: Point } | null>(null)
  const press = useRef<{ entry: Entry; start: Point; dragging: boolean } | null>(null)

  const handlePointerDown = (entry: Entry) => (event: ReactPointerEvent<HTMLElement>) => {
    if (!editing || event.button !== 0) return
    event.preventDefault()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      /* A pointer without capture support still reports moves while over the element. */
    }
    press.current = { entry, start: { x: event.clientX, y: event.clientY }, dragging: false }
  }
  const handlePointerMove = (event: ReactPointerEvent<HTMLElement>): void => {
    const current = press.current
    if (!current) return
    const point = { x: event.clientX, y: event.clientY }
    if (!current.dragging) {
      if (Math.hypot(point.x - current.start.x, point.y - current.start.y) < DRAG_THRESHOLD) return
      current.dragging = true
    }
    setGhost({ entry: current.entry, point })
    onItemDrag?.(point)
  }
  const endPress = (event: ReactPointerEvent<HTMLElement>, drop: boolean): void => {
    const current = press.current
    press.current = null
    setGhost(null)
    onItemDrag?.(null)
    if (current?.dragging && drop)
      onItemDrop?.(current.entry.item, { x: event.clientX, y: event.clientY })
  }

  return (
    <div className="flex size-full flex-col">
      <h2 className="m-0 flex h-9 shrink-0 items-center gap-2 px-3 text-sm font-semibold text-on-surface-variant">
        <FolderTitleIcon icon={tile.icon} />
        <span className="truncate">{tile.title}</span>
      </h2>
      {entries.length === 0 ? (
        <p className="m-0 flex flex-1 items-center justify-center p-3 text-center text-sm text-on-surface-variant">
          {t(editing ? 'dashboard.folder.dropHint' : 'dashboard.folder.empty')}
        </p>
      ) : (
        <ul className="m-0 grid min-h-0 flex-1 list-none auto-rows-min grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-1 overflow-y-auto p-2">
          {entries.map((entry) => (
            <li key={entry.key}>
              {editing ? (
                <div
                  role="img"
                  aria-label={t('dashboard.folder.dragOut', { name: entry.name })}
                  className={cn(
                    ENTRY_CLASS,
                    'cursor-grab touch-none select-none active:cursor-grabbing'
                  )}
                  onPointerDown={handlePointerDown(entry)}
                  onPointerMove={handlePointerMove}
                  onPointerUp={(event) => endPress(event, true)}
                  onPointerCancel={(event) => endPress(event, false)}
                >
                  <EntryContent entry={entry} />
                </div>
              ) : entry.target.kind === 'external' ? (
                <a
                  {...externalLinkProps(entry.target.url)}
                  aria-label={t('shortcut.open', { name: entry.name })}
                  className={ENTRY_CLASS}
                >
                  <EntryContent entry={entry} />
                  <ArrowUpRightIcon
                    aria-hidden="true"
                    className="absolute top-1 right-1 size-3 text-on-surface-variant"
                  />
                </a>
              ) : (
                <Link
                  to="/c/$componentId"
                  params={{ componentId: entry.target.componentId }}
                  aria-label={t('dashboard.openPage', { name: entry.name })}
                  className={ENTRY_CLASS}
                >
                  <EntryContent entry={entry} />
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
      {ghost
        ? createPortal(
            <div
              aria-hidden="true"
              className="pointer-events-none fixed z-50 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1 rounded-lg bg-surface-container-lowest p-2 text-on-surface shadow-overlay"
              style={{ left: ghost.point.x, top: ghost.point.y }}
            >
              <EntryContent entry={ghost.entry} />
            </div>,
            document.body
          )
        : null}
    </div>
  )
}

function EntryContent({ entry }: { entry: Entry }): React.JSX.Element {
  return (
    <>
      <span className="flex size-10 items-center justify-center rounded-lg bg-primary-container text-lg text-on-primary-container">
        {entry.icon}
      </span>
      <span className="line-clamp-2 w-full text-xs font-medium">{entry.name}</span>
    </>
  )
}
