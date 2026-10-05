import type { ComponentType as ReactComponentType } from 'react'
import type { TFunction } from 'i18next'
import type { Component, ComponentType, DesktopModuleId } from '@justcampus/shared'
import { desktopModule } from '@/desktop/bridge'
import { filesAdapter } from './files'
import { iframeAdapter } from './iframe'
import { linkAdapter } from './link'
import { rssAdapter } from './rss'
import { transcriptionAdapter } from './transcription'
import { translatorAdapter } from './translator'
import type { ComponentAdapter, ComponentConfigFieldsProps } from './types'

export const componentAdapters: { [T in ComponentType]: ComponentAdapter<T> } = {
  iframe: iframeAdapter,
  rss: rssAdapter,
  link: linkAdapter,
  translator: translatorAdapter,
  transcription: transcriptionAdapter,
  files: filesAdapter
}

export function getAdapter<T extends ComponentType>(type: T): ComponentAdapter<T> {
  return componentAdapters[type]
}

type AnyComponentView = ReactComponentType<{ component: Component }>

/** An adapter seen through any component: its parts accept the whole `Component` union. */
interface AnyComponentAdapter {
  Page: AnyComponentView
  ConfigFields: ReactComponentType<ComponentConfigFieldsProps<ComponentType>>
  sourceUrl?: (component: Component) => string
  externalUrl?: (component: Component) => string
  feedUrl?: (component: Component) => string
  desktopModule?: DesktopModuleId
  widgets: Readonly<
    Partial<Record<string, { Tile: AnyComponentView; name?: (t: TFunction) => string }>>
  >
}

/**
 * The adapter of a component or type, callable with the whole union.
 * TypeScript cannot tie `componentAdapters[component.type]` back to
 * `component`, but the registry is keyed by type, so the adapter of
 * `component.type` always gets its own kind.
 */
export function adapterOf(componentOrType: Component | ComponentType): AnyComponentAdapter {
  const type = typeof componentOrType === 'string' ? componentOrType : componentOrType.type
  return componentAdapters[type] as unknown as AnyComponentAdapter
}

/**
 * Whether the user can use the component on this device: always, except desktop components
 * outside the desktop app (or a build without their module). Everything a user sees lists only
 * these; admin views list all.
 */
export function isAvailableHere(componentOrType: Component | ComponentType): boolean {
  const module = adapterOf(componentOrType).desktopModule
  return module === undefined || desktopModule(module) !== undefined
}

/** Where a shortcut component leads, or `null` for components that open as a page in the app. */
export function externalUrlOf(component: Component): string | null {
  return adapterOf(component).externalUrl?.(component) ?? null
}

/** The address the admin list shows for a component, or `null` for modules, which have none. */
export function sourceUrlOf(component: Component): string | null {
  return adapterOf(component).sourceUrl?.(component) ?? null
}

/** The feed a component shows, whose unread entries its sidebar entry flags, or `null`. */
export function feedUrlOf(component: Component): string | null {
  return adapterOf(component).feedUrl?.(component) ?? null
}

/** The renderer of one of a component's widgets, or `undefined` if its type has no such widget. */
export function widgetViewOf(
  component: Component,
  widgetKey: string
): { Tile: AnyComponentView; name?: (t: TFunction) => string } | undefined {
  const { widgets } = adapterOf(component)
  return Object.hasOwn(widgets, widgetKey) ? widgets[widgetKey] : undefined
}
