import { useState } from 'react'
import { GripVerticalIcon, PencilIcon, RssIcon, XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button, Card } from '@ki4jlu/design-system'
import {
  widgetRefKey,
  type DashboardTile as Tile,
  type FolderItem,
  type FolderTile as FolderTileData
} from '@justcampus/shared'
import { widgetViewOf } from '@/adapters/registry'
import { useComponentName } from '@/lib/component-name'
import { hostnameTitle } from '@/lib/links'
import { cn } from '@/lib/utils'
import type { ComponentWidget } from '@/lib/widgets'
import { FeedDialog } from './feed-dialog'
import { FeedPanel } from './feed-panel'
import { FolderEditorDialog } from './folder-editor-dialog'
import { FolderTile, type Point } from './folder-tile'
import { ShortcutDialog } from './shortcut-dialog'
import { ShortcutLink } from './shortcut-link'
import { SiteIcon } from './site-icon'

/** Class of the tile's edit-mode overlay, the grid's drag handle. */
export const TILE_HANDLE_CLASS = 'dashboard-tile-handle'

interface DashboardTileProps {
  tile: Tile
  /** Widgets by `widgetRefKey`; a widget tile whose widget is missing is not rendered. */
  widgetsByKey: ReadonlyMap<string, ComponentWidget>
  editing: boolean
  /** A dragged tile hovers this folder and would be dropped into it. */
  dropTarget?: boolean
  onUpdate: (tile: Tile) => void
  onRemove: () => void
  /** An entry is dragged out of this folder (pointer position, `null` at the end). */
  onItemDrag?: (point: Point | null) => void
  onItemDrop?: (folder: FolderTileData, item: FolderItem, point: Point) => void
}

const ICON = { 'aria-hidden': true, width: '1em', height: '1em' } as const

/**
 * A tile is only its content, without a title bar. While arranging, a
 * transparent overlay takes the pointer instead of the content (so a link
 * cannot swallow a drag) and doubles as the drag handle, with the tile's
 * actions in its corner. On a folder the overlay covers only the header row,
 * so the entries inside stay reachable to be dragged out.
 */
export function DashboardTile({
  tile,
  widgetsByKey,
  editing,
  dropTarget = false,
  onUpdate,
  onRemove,
  onItemDrag,
  onItemDrop
}: DashboardTileProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const componentName = useComponentName()
  const [editingTile, setEditingTile] = useState(false)
  const widget = tile.kind === 'widget' ? widgetsByKey.get(widgetRefKey(tile)) : undefined
  if (tile.kind === 'widget' && !widget) return null
  const name =
    tile.kind === 'widget'
      ? componentName(widget!.component)
      : tile.kind === 'feed'
        ? (tile.title ?? t('feed.fallbackName', { host: hostnameTitle(tile.feedUrl) }))
        : tile.title

  return (
    <Card
      role="region"
      aria-label={name}
      data-folder-id={tile.kind === 'folder' ? tile.id : undefined}
      className={cn(
        'relative size-full overflow-hidden',
        editing && 'ring-2 ring-inset ring-primary/40',
        dropTarget && 'ring-4 ring-primary'
      )}
    >
      <div
        data-editing={editing ? '' : undefined}
        className={cn('group/tile size-full', editing && 'select-none')}
      >
        <TileContent
          tile={tile}
          widget={widget}
          widgetsByKey={widgetsByKey}
          editing={editing}
          onItemDrag={onItemDrag}
          onItemDrop={onItemDrop}
        />
      </div>
      {editing ? (
        <div
          className={cn(
            TILE_HANDLE_CLASS,
            'absolute inset-x-0 top-0 flex cursor-move items-start justify-between p-1',
            tile.kind === 'folder' ? 'h-9' : 'bottom-0'
          )}
        >
          <GripVerticalIcon {...ICON} className="m-1.5 text-on-surface-variant" />
          <div className="flex">
            {tile.kind !== 'widget' ? (
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('dashboard.editTile', { name })}
                onClick={() => setEditingTile(true)}
              >
                <PencilIcon {...ICON} />
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('dashboard.removeTile', { name })}
              onClick={onRemove}
            >
              <XIcon {...ICON} />
            </Button>
          </div>
        </div>
      ) : null}
      {editingTile ? (
        <TileEditor
          tile={tile}
          widgetsByKey={widgetsByKey}
          onClose={() => setEditingTile(false)}
          onSave={onUpdate}
        />
      ) : null}
    </Card>
  )
}

interface TileContentProps extends Pick<
  DashboardTileProps,
  'tile' | 'widgetsByKey' | 'editing' | 'onItemDrag' | 'onItemDrop'
> {
  widget: ComponentWidget | undefined
}

function TileContent({
  tile,
  widget,
  widgetsByKey,
  editing,
  onItemDrag,
  onItemDrop
}: TileContentProps): React.JSX.Element | null {
  switch (tile.kind) {
    case 'widget': {
      if (!widget) return null
      const view = widgetViewOf(widget.component, widget.widgetKey)
      return view ? <view.Tile component={widget.component} /> : null
    }
    case 'folder':
      return (
        <FolderTile
          tile={tile}
          widgetsByKey={widgetsByKey}
          editing={editing}
          onItemDrag={onItemDrag}
          onItemDrop={(item, point) => onItemDrop?.(tile, item, point)}
        />
      )
    case 'link':
      return (
        <ShortcutLink
          url={tile.url}
          title={tile.title}
          icon={<SiteIcon url={tile.url} icon={tile.icon} />}
        />
      )
    case 'feed':
      return <FeedPanel feedUrl={tile.feedUrl} title={tile.title} icon={<RssIcon {...ICON} />} />
  }
}

interface TileEditorProps {
  tile: Tile
  widgetsByKey: ReadonlyMap<string, ComponentWidget>
  onClose: () => void
  onSave: (tile: Tile) => void
}

/** The dialog behind a tile's pencil: folder contents, shortcut or feed details. */
function TileEditor({
  tile,
  widgetsByKey,
  onClose,
  onSave
}: TileEditorProps): React.JSX.Element | null {
  const onOpenChange = (open: boolean): void => {
    if (!open) onClose()
  }
  switch (tile.kind) {
    case 'folder':
      return (
        <FolderEditorDialog
          open
          onOpenChange={onOpenChange}
          tile={tile}
          widgets={[...widgetsByKey.values()]}
          onSave={onSave}
        />
      )
    case 'link':
      return (
        <ShortcutDialog
          open
          onOpenChange={onOpenChange}
          shortcut={tile}
          onSave={(shortcut) => onSave({ ...tile, ...shortcut })}
        />
      )
    case 'feed':
      return (
        <FeedDialog
          open
          onOpenChange={onOpenChange}
          feed={tile}
          onSave={(feed) => onSave({ ...tile, ...feed })}
        />
      )
    case 'widget':
      return null
  }
}
