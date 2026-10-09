import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CheckIcon, LayoutDashboardIcon, PencilIcon, PlusIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@ki4jlu/design-system'
import { widgetRefKey, type DashboardTile, type FolderTemplate } from '@justcampus/shared'
import {
  appendFeedTile,
  appendFolder,
  appendLinkTile,
  appendTile,
  fitTiles,
  folderFromTemplate,
  knownTiles,
  type FeedFields,
  type ShortcutFields
} from '@/lib/dashboard'
import { TOUR } from '@/lib/tour-targets'
import type { ComponentWidget } from '@/lib/widgets'
import { AddWidgetDialog } from './add-widget-dialog'
import { DashboardGrid } from './dashboard-grid'
import { FeedDialog } from './feed-dialog'
import { ShortcutDialog } from './shortcut-dialog'

const SAVE_DELAY_MS = 600
const ICON = { 'aria-hidden': true, width: '1em', height: '1em' } as const

/** Calls `save` 600 ms after the last change, at once on `flush`, and on unmount. */
function useDebouncedSaver(save: (tiles: DashboardTile[]) => void): {
  schedule: (tiles: DashboardTile[]) => void
  flush: () => void
} {
  const saveRef = useRef(save)
  const timer = useRef<number | undefined>(undefined)
  const pending = useRef<DashboardTile[] | null>(null)

  useEffect(() => {
    saveRef.current = save
  }, [save])

  const flush = useCallback(() => {
    window.clearTimeout(timer.current)
    const tiles = pending.current
    pending.current = null
    if (tiles) saveRef.current(tiles)
  }, [])

  const schedule = useCallback(
    (tiles: DashboardTile[]) => {
      pending.current = tiles
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(flush, SAVE_DELAY_MS)
    },
    [flush]
  )

  useEffect(() => flush, [flush])
  return { schedule, flush }
}

export interface DashboardEditorHeader {
  /** "Add widget" while editing, and the edit/done toggle. */
  actions: ReactNode
  editing: boolean
}

interface DashboardEditorProps {
  /** The saved tiles. While they are being arranged the editor shows its own draft. */
  tiles: DashboardTile[]
  /** Every widget of every enabled component, in catalogue order. */
  widgets: ComponentWidget[]
  /** Folder templates offered in the "add widget" dialog. */
  templates: FolderTemplate[]
  /** Persists the tiles: debounced while arranging, at once when editing ends or on unmount. */
  onSave: (tiles: DashboardTile[]) => void
  /** Renders the header with the editor's actions; the caller decides where they go. */
  header: (header: DashboardEditorHeader) => ReactNode
  /** Title and text of the card shown while there are no tiles. */
  empty: { title: string; description: string }
}

/**
 * A dashboard grid with its edit mode: arranging and resizing tiles, the "add widget" dialog
 * (widgets, folders, folder templates, shortcuts, feeds) and the tiles' own editors. Where the
 * tiles come from and where they are saved is up to the caller: the user's own dashboard or an
 * admin's layout preset.
 */
export function DashboardEditor({
  tiles: saved,
  widgets,
  templates,
  onSave,
  header,
  empty
}: DashboardEditorProps): React.JSX.Element {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<DashboardTile[] | null>(null)
  const [adding, setAdding] = useState(false)
  /** The user's own tile being set up after "Add widget". */
  const [creating, setCreating] = useState<'shortcut' | 'feed' | null>(null)
  const saver = useDebouncedSaver(onSave)

  const widgetsByKey = useMemo(
    () => new Map(widgets.map((widget) => [widgetRefKey(widget), widget])),
    [widgets]
  )
  // Tiles of deleted or disabled components are not shown; shortcuts and feeds always are.
  const tiles = useMemo(
    () => fitTiles(knownTiles(draft ?? saved, widgetsByKey), widgetsByKey),
    [draft, saved, widgetsByKey]
  )

  const change = (next: DashboardTile[]): void => {
    setDraft(next)
    saver.schedule(next)
  }
  const startEditing = (): void => {
    setDraft(tiles)
    setEditing(true)
  }
  const finishEditing = (): void => {
    saver.flush()
    setEditing(false)
    setDraft(null)
  }
  const add = (next: DashboardTile[]): void => {
    setAdding(false)
    setEditing(true)
    change(next)
  }
  const addWidget = (widget: ComponentWidget): void => add(appendTile(tiles, widget))
  const addFolder = (): void =>
    add(appendFolder(tiles, { title: t('dashboard.folder.defaultTitle'), icon: null, items: [] }))
  const addTemplate = (template: FolderTemplate): void =>
    add(appendFolder(tiles, folderFromTemplate(template, widgetsByKey)))
  const addShortcut = (shortcut: ShortcutFields): void => add(appendLinkTile(tiles, shortcut))
  const addFeed = (feed: FeedFields): void => add(appendFeedTile(tiles, feed))
  const startCreating = (kind: 'shortcut' | 'feed'): void => {
    setAdding(false)
    setCreating(kind)
  }
  const stopCreating = (open: boolean): void => {
    if (!open) setCreating(null)
  }
  const updateTile = (updated: DashboardTile): void =>
    change(tiles.map((tile) => (tile.id === updated.id ? updated : tile)))

  const actions = (
    <>
      {editing ? (
        <Button
          variant="outline"
          onClick={() => setAdding(true)}
          data-tour={TOUR.dashboardAddWidget}
        >
          <PlusIcon {...ICON} />
          {t('dashboard.addWidget')}
        </Button>
      ) : null}
      {tiles.length > 0 || editing ? (
        <Button
          variant={editing ? 'default' : 'outline'}
          aria-pressed={editing}
          onClick={editing ? finishEditing : startEditing}
          data-tour={TOUR.dashboardEdit}
        >
          {editing ? <CheckIcon {...ICON} /> : <PencilIcon {...ICON} />}
          {editing ? t('dashboard.done') : t('dashboard.edit')}
        </Button>
      ) : null}
    </>
  )

  return (
    <>
      {header({ actions, editing })}
      {tiles.length === 0 ? (
        <EmptyDashboard {...empty} onAdd={() => setAdding(true)} />
      ) : (
        <DashboardGrid
          tiles={tiles}
          widgetsByKey={widgetsByKey}
          editing={editing}
          onTilesChange={change}
          onUpdateTile={updateTile}
          onRemoveTile={(id) => change(tiles.filter((tile) => tile.id !== id))}
        />
      )}
      <AddWidgetDialog
        open={adding}
        onOpenChange={setAdding}
        widgets={widgets}
        templates={templates}
        onAdd={addWidget}
        onAddFolder={addFolder}
        onAddTemplate={addTemplate}
        onAddShortcut={() => startCreating('shortcut')}
        onAddFeed={() => startCreating('feed')}
      />
      {creating === 'shortcut' ? (
        <ShortcutDialog open onOpenChange={stopCreating} shortcut={null} onSave={addShortcut} />
      ) : null}
      {creating === 'feed' ? (
        <FeedDialog open onOpenChange={stopCreating} feed={null} onSave={addFeed} />
      ) : null}
    </>
  )
}

function EmptyDashboard({
  title,
  description,
  onAdd
}: {
  title: string
  description: string
  onAdd: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Card>
      <CardHeader className="items-center text-center">
        <LayoutDashboardIcon {...ICON} className="size-10 text-on-surface-variant" />
        <CardTitle asChild>
          <h2>{title}</h2>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex justify-center">
        <Button onClick={onAdd} data-tour={TOUR.dashboardAddWidget}>
          <PlusIcon {...ICON} />
          {t('dashboard.addWidget')}
        </Button>
      </CardContent>
    </Card>
  )
}
