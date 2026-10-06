import type { ComponentType as ReactComponentType } from 'react'
import type { TFunction } from 'i18next'
import type { Component, ComponentType, DesktopModuleId, WidgetKey } from '@justcampus/shared'
import type { SecretDrafts } from '@/lib/component-secrets'

export type ComponentOf<T extends ComponentType> = Extract<Component, { type: T }>
export type ComponentConfigOf<T extends ComponentType> = ComponentOf<T>['config']

export interface ComponentViewProps<T extends ComponentType> {
  component: ComponentOf<T>
}

export interface ComponentConfigFieldsProps<T extends ComponentType> {
  config: ComponentConfigOf<T>
  onChange: (config: ComponentConfigOf<T>) => void
  /** Validation messages keyed by the path inside `config`, e.g. `url`. */
  errors: Partial<Record<string, string>>
  /** The secrets as typed in the form so far (see `SecretField`), not yet saved. */
  secrets: SecretDrafts
  /** Prefix for element ids, unique per form. */
  idPrefix: string
}

/** How one widget of a component type is drawn on the dashboard. */
export interface WidgetView<T extends ComponentType> {
  /** Body of a dashboard tile; fills the whole tile. */
  Tile: ReactComponentType<ComponentViewProps<T>>
  /**
   * What the widget shows, beside its component's name where widgets are listed to add; for
   * types that offer more than one widget.
   */
  name?: (t: TFunction) => string
}

/**
 * Everything the app needs to know about one component type. A new adapter is
 * a folder under `src/adapters/` plus one line in the registry.
 */
export interface ComponentAdapter<T extends ComponentType> {
  type: T
  /** The component's full page at `/c/$componentId`; fills the main area. */
  Page: ReactComponentType<ComponentViewProps<T>>
  /**
   * The type-specific part of the admin's component editor: one `FormSection` card per group of
   * settings, or a single one titled with `admin.form.configuration`.
   */
  ConfigFields: ReactComponentType<ComponentConfigFieldsProps<T>>
  defaultConfig: ComponentConfigOf<T>
  /**
   * The address the component shows, fetches or opens; the admin list displays it. Modules,
   * built into the app, have none.
   */
  sourceUrl?: (component: ComponentOf<T>) => string
  /**
   * Set for components that live outside the app (shortcuts): sidebar entries,
   * folder entries and tiles open this URL externally instead of `/c/$componentId`.
   */
  externalUrl?: (component: ComponentOf<T>) => string
  /**
   * Set for components that show a feed: their sidebar entry carries a marker while the feed has
   * entries newer than the user's last read.
   */
  feedUrl?: (component: ComponentOf<T>) => string
  /**
   * Set for desktop components (see `DESKTOP_COMPONENT_TYPES`): the desktop module the page needs.
   * Where the desktop app does not offer it (the browser, the PWA), users never see the component;
   * admins still do, to place it in presets.
   */
  desktopModule?: DesktopModuleId
  /** A renderer for every widget the type offers (see `COMPONENT_WIDGETS`). */
  widgets: { [K in WidgetKey<T>]: WidgetView<T> }
}
