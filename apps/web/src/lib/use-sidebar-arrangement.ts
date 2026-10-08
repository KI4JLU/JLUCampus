import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  closestCenter,
  getFirstCollision,
  KeyboardSensor,
  MouseSensor,
  pointerWithin,
  rectIntersection,
  TouchSensor,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DndContextProps,
  type DragEndEvent,
  type DragOverEvent,
  type UniqueIdentifier
} from '@dnd-kit/core'
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import { useTranslation } from 'react-i18next'
import type { Component } from '@justcampus/shared'
import { useComponentName } from './component-name'

export type SidebarList = 'sidebar' | 'available'
export type SidebarLists = Record<SidebarList, string[]>

const LISTS: SidebarList[] = ['sidebar', 'available']

interface SidebarArrangementOptions {
  /** Every component that can go into the sidebar. */
  catalogue: Component[] | undefined
  /** The saved sidebar, in its order. */
  componentIds: string[] | undefined
  /**
   * Persists a new sidebar. `onSettled` runs once the save has finished either way; until then
   * a dropped order stays on screen, so the saved ids should update at once (optimistically).
   */
  onSave: (componentIds: string[], onSettled?: () => void) => void
}

export interface SidebarArrangement {
  lists: SidebarLists
  byId: ReadonlyMap<string, Component>
  /** The row being dragged, by pointer or keyboard. */
  activeId: string | null
  /** The component being dragged, for the drag overlay. */
  activeComponent: Component | undefined
  /** Last add or remove, for a polite live region. */
  status: string
  listRef: React.RefObject<HTMLUListElement | null>
  availableRef: React.RefObject<HTMLUListElement | null>
  /** Spread onto the `DndContext` that holds both lists. */
  dndProps: Pick<
    DndContextProps,
    | 'sensors'
    | 'collisionDetection'
    | 'onDragStart'
    | 'onDragOver'
    | 'onDragEnd'
    | 'onDragCancel'
    | 'accessibility'
  >
  /** Add or remove without dragging; focus moves to a neighbour in the list the row leaves. */
  add: (id: string) => void
  remove: (id: string) => void
}

function sameOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

function listOf(id: UniqueIdentifier, lists: SidebarLists): SidebarList | undefined {
  if (id === 'sidebar' || id === 'available') return id
  return LISTS.find((list) => lists[list].includes(String(id)))
}

/**
 * The state behind a sidebar editor: the sidebar and the components not in it, dragged between
 * and within the two lists with pointer or keyboard, or moved with the rows' buttons. Where the
 * lists come from and where they are saved is up to the caller (the user's own sidebar, a preset).
 */
export function useSidebarArrangement({
  catalogue,
  componentIds,
  onSave
}: SidebarArrangementOptions): SidebarArrangement {
  const { t } = useTranslation()
  const componentName = useComponentName()
  const listRef = useRef<HTMLUListElement | null>(null)
  const availableRef = useRef<HTMLUListElement | null>(null)
  const dragging = useRef(false)
  const [draft, setDraft] = useState<SidebarLists | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const pendingFocus = useRef<{ list: SidebarList; index: number } | null>(null)
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const byId = useMemo(
    () => new Map((catalogue ?? []).map((component) => [component.id, component])),
    [catalogue]
  )
  const saved = useMemo<SidebarLists>(() => {
    const ids = (componentIds ?? []).filter((id) => byId.has(id))
    const available = [...(catalogue ?? [])]
      .filter((component) => !ids.includes(component.id))
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((component) => component.id)
    return { sidebar: ids, available }
  }, [componentIds, catalogue, byId])
  const lists = draft ?? saved
  // Announcements and drag handlers read the lists of the moment, not of the last render.
  const listsRef = useRef(lists)
  useLayoutEffect(() => {
    listsRef.current = lists
  }, [lists])
  const changeDraft = (next: SidebarLists | null): void => {
    listsRef.current = next ?? saved
    setDraft(next)
  }

  // The rows' buttons as rendered, so a search that hides rows does not shift the neighbours.
  const actionsIn = (ref: typeof listRef): HTMLElement[] => [
    ...(ref.current?.querySelectorAll<HTMLElement>('[data-row-action]') ?? [])
  ]
  const renderedIndex = (ref: typeof listRef, id: string): number =>
    actionsIn(ref).findIndex((action) => action.dataset.rowAction === id)

  // After a button moved the focused row out of its list, focus its neighbour's button instead of
  // losing focus to <body>.
  useLayoutEffect(() => {
    const target = pendingFocus.current
    if (!target) return
    pendingFocus.current = null
    const [own, other] =
      target.list === 'sidebar' ? [listRef, availableRef] : [availableRef, listRef]
    const actions = actionsIn(own)
    const next =
      actions[Math.min(Math.max(target.index, 0), actions.length - 1)] ?? actionsIn(other)[0]
    next?.focus()
  }, [lists])

  const nameOf = (id: UniqueIdentifier): string => {
    const component = byId.get(String(id))
    return component ? componentName(component) : ''
  }

  const add = (id: string): void => {
    pendingFocus.current = { list: 'available', index: renderedIndex(availableRef, id) }
    setStatus(t('sidebarEditor.added', { name: nameOf(id) }))
    onSave([...lists.sidebar, id])
  }
  const remove = (id: string): void => {
    pendingFocus.current = { list: 'sidebar', index: renderedIndex(listRef, id) }
    setStatus(t('sidebarEditor.removed', { name: nameOf(id) }))
    onSave(lists.sidebar.filter((other) => other !== id))
  }

  // Pointer first, so a drop lands where the pointer is; over a list, snap to its closest row.
  const collisionDetection: CollisionDetection = (args) => {
    const hits = pointerWithin(args)
    const overId = getFirstCollision(hits.length > 0 ? hits : rectIntersection(args), 'id')
    if (overId == null) return []
    if (overId === 'sidebar' || overId === 'available') {
      // Only rows on screen count; a search may hide every row of a list.
      const rows = listsRef.current[overId]
      const closest = closestCenter({
        ...args,
        droppableContainers: args.droppableContainers.filter((container) =>
          rows.includes(String(container.id))
        )
      })
      return closest.length > 0 ? closest : [{ id: overId }]
    }
    return [{ id: overId }]
  }

  // Crossing into the other list moves the row there at once, so it can be sorted before the drop.
  const handleDragOver = ({ active, over }: DragOverEvent): void => {
    if (!over) return
    const current = listsRef.current
    const from = listOf(active.id, current)
    const to = listOf(over.id, current)
    if (!from || !to || from === to) return
    const id = String(active.id)
    const target = current[to]
    const overIndex = target.indexOf(String(over.id))
    const translated = active.rect.current.translated
    const below = translated
      ? translated.top + translated.height / 2 > over.rect.top + over.rect.height / 2
      : false
    const index = overIndex < 0 ? target.length : overIndex + (below ? 1 : 0)
    changeDraft({
      ...current,
      [from]: current[from].filter((other) => other !== id),
      [to]: [...target.slice(0, index), id, ...target.slice(index)]
    })
  }

  const handleDragEnd = ({ active, over }: DragEndEvent): void => {
    dragging.current = false
    setActiveId(null)
    const current = listsRef.current
    if (!over) {
      changeDraft(null)
      return
    }
    let next = current.sidebar
    if (listOf(active.id, current) === 'sidebar' && listOf(over.id, current) === 'sidebar') {
      const from = next.indexOf(String(active.id))
      const to = over.id === 'sidebar' ? next.length - 1 : next.indexOf(String(over.id))
      if (from >= 0 && to >= 0 && from !== to) next = arrayMove(next, from, to)
    }
    if (sameOrder(next, saved.sidebar)) {
      changeDraft(null)
      return
    }
    // Keep the dropped order on screen until the optimistic cache update has landed.
    changeDraft({ ...current, sidebar: next })
    onSave(next, () => {
      if (!dragging.current) setDraft(null)
    })
  }

  const positionIn = (list: SidebarList, id: UniqueIdentifier): number =>
    listsRef.current[list].indexOf(String(id)) + 1
  const describeOver = (active: UniqueIdentifier, over: UniqueIdentifier | undefined): string => {
    const name = nameOf(active)
    const list = over === undefined ? undefined : listOf(over, listsRef.current)
    if (!list) return t('sidebarEditor.dnd.outside', { name })
    if (list === 'available') return t('sidebarEditor.dnd.overAvailable', { name })
    const rows = listsRef.current.sidebar
    const position =
      over === 'sidebar' || over === undefined ? rows.length : positionIn('sidebar', over)
    return t('sidebarEditor.dnd.overSidebar', { name, position, total: rows.length })
  }
  const announcements: Announcements = {
    onDragStart: ({ active }) =>
      listOf(active.id, listsRef.current) === 'sidebar'
        ? t('sidebarEditor.dnd.pickedUp', {
            name: nameOf(active.id),
            position: positionIn('sidebar', active.id),
            total: listsRef.current.sidebar.length
          })
        : t('sidebarEditor.dnd.pickedUpAvailable', { name: nameOf(active.id) }),
    onDragOver: ({ active, over }) => describeOver(active.id, over?.id),
    onDragEnd: ({ active, over }) =>
      over
        ? listOf(over.id, listsRef.current) === 'available'
          ? t('sidebarEditor.dnd.droppedAvailable', { name: nameOf(active.id) })
          : t('sidebarEditor.dnd.droppedSidebar', {
              name: nameOf(active.id),
              position: positionIn('sidebar', active.id),
              total: listsRef.current.sidebar.length
            })
        : t('sidebarEditor.dnd.cancelled', { name: nameOf(active.id) }),
    onDragCancel: ({ active }) => t('sidebarEditor.dnd.cancelled', { name: nameOf(active.id) })
  }

  return {
    lists,
    byId,
    activeId,
    activeComponent: activeId ? byId.get(activeId) : undefined,
    status,
    listRef,
    availableRef,
    dndProps: {
      sensors,
      collisionDetection,
      onDragStart: ({ active }) => {
        dragging.current = true
        setActiveId(String(active.id))
        changeDraft(listsRef.current)
      },
      onDragOver: handleDragOver,
      onDragEnd: handleDragEnd,
      onDragCancel: () => {
        dragging.current = false
        setActiveId(null)
        changeDraft(null)
      },
      accessibility: {
        announcements,
        screenReaderInstructions: { draggable: t('sidebarEditor.dnd.instructions') }
      }
    },
    add,
    remove
  }
}
