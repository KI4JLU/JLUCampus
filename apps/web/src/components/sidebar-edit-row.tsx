import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVerticalIcon, MonitorIcon, PlusIcon, XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button, navItemVariants } from '@ki4jlu/design-system'
import { isDesktopComponentType, type Component } from '@justcampus/shared'
import { externalUrlOf } from '@/adapters/registry'
import { useComponentName } from '@/lib/component-name'
import type { SidebarList } from '@/lib/use-sidebar-arrangement'
import { cn } from '@/lib/utils'
import { ComponentIcon } from './component-icon'

interface SidebarEditRowProps {
  component: Component
  list: SidebarList
  /** Adds the component (available list) or removes it (sidebar list): the drag-free alternative. */
  onAction: () => void
}

const icon = { 'aria-hidden': true, width: '1em', height: '1em' } as const

/**
 * A sidebar link's box (same padding and type); the dashed outline marks the row as movable
 * without taking up space.
 */
const editRowClass = cn(
  navItemVariants({ level: 'top' }),
  'outline-1 -outline-offset-1 outline-outline-variant outline-dashed'
)

/**
 * One component while the sidebar is being edited. The whole row drags with mouse or touch;
 * the leading grip is the keyboard handle, and the trailing button adds or removes without dragging.
 */
export function SidebarEditRow({
  component,
  list,
  onAction
}: SidebarEditRowProps): React.JSX.Element {
  const { t } = useTranslation()
  const componentName = useComponentName()
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: component.id, data: { list } })
  const { onKeyDown, ...pointerListeners } = listeners ?? {}
  const adding = list === 'available'

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(editRowClass, 'cursor-grab', isDragging && 'opacity-40')}
      {...pointerListeners}
    >
      {/* Negative margins keep the 32px buttons inside the link's 24px line box. */}
      <Button
        ref={setActivatorNodeRef}
        variant="ghost"
        size="icon"
        className="-my-1 -ml-2 shrink-0 cursor-grab"
        {...attributes}
        aria-label={t('sidebarEditor.move', { name: componentName(component) })}
        onKeyDown={(event) => onKeyDown?.(event)}
      >
        <GripVerticalIcon {...icon} />
      </Button>
      <RowLabel component={component} />
      <RowAction component={component} action={adding ? 'add' : 'remove'} onAction={onAction} />
    </li>
  )
}

/**
 * Icon and name, as in the sidebar's link. Desktop components are marked: they show only in the
 * desktop app, which matters where the browser lists them anyway (layout presets).
 */
function RowLabel({ component }: { component: Component }): React.JSX.Element {
  const { t } = useTranslation()
  const componentName = useComponentName()
  return (
    <>
      <ComponentIcon
        icon={component.icon}
        iconUrl={component.iconUrl}
        siteUrl={externalUrlOf(component)}
      />
      <span className="min-w-0 flex-1 truncate">{componentName(component)}</span>
      {isDesktopComponentType(component.type) ? (
        // The rows are narrow: a badge would squeeze the name, so the mark is an icon.
        <span className="shrink-0 text-on-surface-variant" title={t('sidebarEditor.desktopBadge')}>
          <MonitorIcon aria-hidden="true" width="1em" height="1em" />
          <span className="sr-only">{t('sidebarEditor.desktopBadge')}</span>
        </span>
      ) : null}
    </>
  )
}

interface RowActionProps {
  component: Component
  action: 'add' | 'remove'
  onAction: () => void
}

/** The trailing add or remove button; the arrangement finds it by `data-row-action` for focus. */
function RowAction({ component, action, onAction }: RowActionProps): React.JSX.Element {
  const { t } = useTranslation()
  const componentName = useComponentName()
  return (
    <Button
      variant="ghost"
      size="icon"
      className="-my-1 -mr-2 shrink-0"
      data-row-action={component.id}
      aria-label={t(action === 'add' ? 'sidebarEditor.add' : 'sidebarEditor.remove', {
        name: componentName(component)
      })}
      onClick={onAction}
    >
      {action === 'add' ? <PlusIcon {...icon} /> : <XIcon {...icon} />}
    </Button>
  )
}

/** What follows the pointer while a row is dragged, between the sidebar and the panel. */
export function SidebarDragPreview({ component }: { component: Component }): React.JSX.Element {
  return (
    <div className={cn(editRowClass, 'cursor-grabbing bg-surface-container-lowest shadow-overlay')}>
      <span className="-my-1 -ml-2 flex size-8 shrink-0 items-center justify-center">
        <GripVerticalIcon {...icon} />
      </span>
      <RowLabel component={component} />
    </div>
  )
}

/** Stands in for the rows of an empty list, which stays a drop target. */
export function SidebarEmptyRow({ children }: { children: string }): React.JSX.Element {
  return (
    <li className={cn(editRowClass, 'text-sm text-on-surface-variant hover:bg-transparent')}>
      <span>{children}</span>
    </li>
  )
}
