/**
 * The contract between the JLU Campus server and its two frontends (web and
 * desktop). Everything that crosses the HTTP boundary is described here once,
 * as Zod schemas; the server validates request bodies with them and the
 * clients type their responses from them.
 */
import { z } from 'zod'
import { httpsUrlSchema, SECRET_VALUE_MAX } from './common'
import {
  TRANSCRIPTION_SECRET_KEYS,
  transcriptionComponentConfigSchema,
  type TranscriptionComponentConfig
} from './transcription'

export { httpsUrlSchema, SECRET_VALUE_MAX } from './common'
export * from './transcription'

// ---------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------

export const LANGUAGES = ['de', 'en'] as const
export const languageSchema = z.enum(LANGUAGES)
export type Language = z.infer<typeof languageSchema>
export const DEFAULT_LANGUAGE: Language = 'de'

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export const USER_ROLES = ['user', 'admin'] as const
export const userRoleSchema = z.enum(USER_ROLES)
export type UserRole = z.infer<typeof userRoleSchema>

/** The signed-in user as the API reports them. */
export const meSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  image: z.string().nullable(),
  role: userRoleSchema,
  /** `null` until the user picked one; clients then fall back to the browser language. */
  language: languageSchema.nullable()
})
export type Me = z.infer<typeof meSchema>

export const mePatchSchema = z.object({
  language: languageSchema.nullable().optional()
})
export type MePatch = z.infer<typeof mePatchSchema>

// ---------------------------------------------------------------------------
// Dashboard grid geometry
// ---------------------------------------------------------------------------

/** Column count of the dashboard grid at desktop width. */
export const DASHBOARD_COLS = 12
/** Height of one grid row in CSS pixels. */
export const DASHBOARD_ROW_HEIGHT = 48
export const TILE_MIN_W = 2
export const TILE_MIN_H = 2
export const TILE_MAX_H = 40
/** Size of a freshly added tile. */
export const TILE_DEFAULT_W = 4
export const TILE_DEFAULT_H = 6

// ---------------------------------------------------------------------------
// Components (the admin-managed catalogue; each one is a page in the sidebar)
// ---------------------------------------------------------------------------

/**
 * Component adapters: `iframe` embeds a site, `rss` shows a feed, `link` is a
 * shortcut that opens its URL outside the app, `translator` and `transcription` are modules (see
 * `SINGLETON_COMPONENT_TYPES`), `files` a desktop component (see
 * `DESKTOP_COMPONENT_TYPES`). The type decides the page and the widgets a
 * component adds (see `COMPONENT_WIDGETS`). A future adapter (Stud.IP, …) adds
 * a literal here, a config schema, its widgets, and a renderer in the web
 * app's adapter registry.
 */
export const COMPONENT_TYPES = [
  'iframe',
  'rss',
  'link',
  'translator',
  'transcription',
  'files'
] as const
export const componentTypeSchema = z.enum(COMPONENT_TYPES)
export type ComponentType = z.infer<typeof componentTypeSchema>

/**
 * Modules: small apps built into JLU Campus rather than links to somewhere
 * else. Each module type exists as exactly one component, which the server
 * creates (disabled) at startup; admins configure and enable it but cannot
 * create a second one or delete it. A module has its own endpoints under
 * `API.module(type)`, may keep secrets (API keys, see `COMPONENT_SECRETS`)
 * and may own database tables that reference its component.
 */
export const SINGLETON_COMPONENT_TYPES = [
  'translator',
  'transcription'
] as const satisfies readonly ComponentType[]
export type SingletonComponentType = (typeof SINGLETON_COMPONENT_TYPES)[number]

export function isSingletonType(type: ComponentType): type is SingletonComponentType {
  return (SINGLETON_COMPONENT_TYPES as readonly ComponentType[]).includes(type)
}

/**
 * Desktop components: the catalogue's reference to a desktop module that has
 * a page (see `DESKTOP_MODULE_IDS`). The page and everything it does live in
 * the Electron app; the row only lets users place the page in their sidebar
 * like any other component, and admins put it into layout presets. Like a
 * module, each type exists as one component that the server creates (enabled,
 * there is nothing to configure) and nobody can create a second of or delete.
 * It has no endpoints, no secrets and no widgets. The web app and PWA hide
 * these components; a type's name is the id of its desktop module.
 */
export const DESKTOP_COMPONENT_TYPES = ['files'] as const satisfies readonly (ComponentType &
  DesktopModuleId)[]
export type DesktopComponentType = (typeof DESKTOP_COMPONENT_TYPES)[number]

export function isDesktopComponentType(type: ComponentType): type is DesktopComponentType {
  return (DESKTOP_COMPONENT_TYPES as readonly ComponentType[]).includes(type)
}

/** Types the server creates itself, once each: modules and desktop components. */
export function isBuiltInType(type: ComponentType): boolean {
  return isSingletonType(type) || isDesktopComponentType(type)
}

/**
 * Any `http:` or `https:` URL. Used where nothing is embedded into the app
 * (shortcuts open in a new tab, feeds are fetched by the server), so plain
 * http is harmless here.
 */
export const externalUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .url()
  .refine(
    (value) => {
      let url: URL
      try {
        url = new URL(value)
      } catch {
        return false
      }
      return url.protocol === 'https:' || url.protocol === 'http:'
    },
    { message: 'URL must use http or https' }
  )

export const iframeComponentConfigSchema = z.object({
  url: httpsUrlSchema
})
export type IframeComponentConfig = z.infer<typeof iframeComponentConfigSchema>

export const rssComponentConfigSchema = z.object({
  /** RSS 2.0, RSS 1.0 (RDF), Atom or JSON Feed; fetched through `API.feed`. */
  feedUrl: externalUrlSchema
})
export type RssComponentConfig = z.infer<typeof rssComponentConfigSchema>

export const linkComponentConfigSchema = z.object({
  url: externalUrlSchema
})
export type LinkComponentConfig = z.infer<typeof linkComponentConfigSchema>

/** Desktop components keep their settings on the device, so their config is empty. */
export const desktopComponentConfigSchema = z.strictObject({})
export type DesktopComponentConfig = z.infer<typeof desktopComponentConfigSchema>

/**
 * Languages the translator offers, in the order its menus list them (after
 * HAWKI's): English in its British and American variants, then German and the
 * rest. Codes are ISO 639-1, English with its region as DeepL takes it.
 */
export const TRANSLATOR_LANGUAGES = [
  'en-gb',
  'en-us',
  'de',
  'uk',
  'fr',
  'es',
  'it',
  'nl',
  'pl',
  'pt',
  'ru',
  'zh',
  'ja'
] as const
export const translatorLanguageSchema = z.enum(TRANSLATOR_LANGUAGES)
export type TranslatorLanguage = z.infer<typeof translatorLanguageSchema>

/**
 * A language code as a service or an older release gave it, as one the translator offers:
 * case and region are normalised, plain English is British English. Anything else is `null`.
 */
export function toTranslatorLanguage(value: unknown): TranslatorLanguage | null {
  if (typeof value !== 'string') return null
  const code = value.trim().toLowerCase().replace('_', '-')
  if (code === 'en') return 'en-gb'
  if ((TRANSLATOR_LANGUAGES as readonly string[]).includes(code)) return code as TranslatorLanguage
  const base = code.split('-')[0]!
  if (base === 'en') return 'en-gb'
  return (TRANSLATOR_LANGUAGES as readonly string[]).includes(base)
    ? (base as TranslatorLanguage)
    : null
}

/** A stored language: `en` from before the regional variants reads as British English. */
const storedTranslatorLanguageSchema = z.preprocess(
  (value) => (value === 'en' ? 'en-gb' : value),
  translatorLanguageSchema
)

/**
 * An engine the translator offers: `deepl`, or `llm:` followed by the id of
 * one of the admin's `llmModels`.
 */
export const translatorEngineIdSchema = z
  .string()
  .regex(/^(deepl|llm:.{1,200})$/, 'Expected "deepl" or "llm:<model id>"')
export type TranslatorEngineId = z.infer<typeof translatorEngineIdSchema>

/**
 * One model of the translator's OpenAI-compatible endpoint (`llmBaseUrl`).
 * `id` is what the endpoint expects in `model`; `label` is what users see.
 */
export const translatorLlmModelSchema = z.object({
  id: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(80)
})
export type TranslatorLlmModel = z.infer<typeof translatorLlmModelSchema>

export const TRANSLATOR_LLM_MODELS_MAX = 20

/**
 * The translator works with two kinds of engines: DeepL (translate, and
 * DeepL Write to rephrase) and the models of an OpenAI-compatible chat
 * completions endpoint. DeepL is offered once its API key is set, each listed
 * model once `llmBaseUrl` is set. Fields added after the first release have
 * defaults, so older stored configs still parse.
 */
export const translatorComponentConfigSchema = z.object({
  /** Target language a user starts with. */
  defaultTargetLanguage: storedTranslatorLanguageSchema,
  /**
   * DeepL API origin, e.g. `https://api.deepl.com`. `null` picks it from the
   * key: free keys (ending in `:fx`) use `https://api-free.deepl.com`.
   */
  deeplApiUrl: httpsUrlSchema.nullable().default(null),
  /** Base URL of the OpenAI-compatible API, up to and including `/v1`. */
  llmBaseUrl: httpsUrlSchema.nullable().default(null),
  llmModels: z
    .array(translatorLlmModelSchema)
    .max(TRANSLATOR_LLM_MODELS_MAX)
    .refine((models) => new Set(models.map((model) => model.id)).size === models.length, {
      message: 'Model ids must be unique'
    })
    .default([]),
  /** What the model picker calls the models' provider, e.g. `KI@JLU`; `null`: "AI models". */
  llmProviderName: z.string().trim().max(40).nullable().default(null),
  /** Engine id (see `translatorEngineIdSchema`) users start with; `null` or unavailable: the first one. */
  defaultEngine: translatorEngineIdSchema.nullable().default(null),
  /** Offers document translation (DeepL only, so it also needs the DeepL key). */
  documentsEnabled: z.boolean().default(false)
})
export type TranslatorComponentConfig = z.infer<typeof translatorComponentConfigSchema>

export type ComponentConfig =
  | IframeComponentConfig
  | RssComponentConfig
  | LinkComponentConfig
  | TranslatorComponentConfig
  | TranscriptionComponentConfig
  | DesktopComponentConfig

// ---------------------------------------------------------------------------
// Component secrets (admin-only settings such as API keys)
// ---------------------------------------------------------------------------

/**
 * The secrets each component type keeps. The server stores them encrypted and
 * never returns them: admins only learn whether each one is set
 * (`adminComponentSchema.secrets`) and can replace or remove it. Only the
 * type's own endpoints (`API.module`) read them.
 */
export const COMPONENT_SECRETS = {
  iframe: [],
  rss: [],
  link: [],
  translator: ['deeplApiKey', 'llmApiKey'],
  transcription: TRANSCRIPTION_SECRET_KEYS,
  files: []
} as const satisfies { [T in ComponentType]: readonly string[] }

export type SecretKey<T extends ComponentType = ComponentType> = T extends ComponentType
  ? (typeof COMPONENT_SECRETS)[T][number]
  : never

/**
 * A change to one secret: a string sets it, `null` removes it, an absent key
 * leaves it unchanged. Omitting `secrets` altogether changes nothing.
 */
const secretChangeSchema = z.string().trim().min(1).max(SECRET_VALUE_MAX).nullable().optional()

const translatorSecretsInputSchema = z
  .strictObject({ deeplApiKey: secretChangeSchema, llmApiKey: secretChangeSchema })
  .optional()

const transcriptionSecretsInputSchema = z
  .strictObject({
    apiKey: secretChangeSchema,
    diarizationApiKey: secretChangeSchema,
    llmApiKey: secretChangeSchema,
    openaiRealtimeApiKey: secretChangeSchema
  })
  .optional()

/** Which of a component's secrets are set, keyed by secret. */
const translatorSecretsStatusSchema = z.object({ deeplApiKey: z.boolean(), llmApiKey: z.boolean() })
const transcriptionSecretsStatusSchema = z.object({
  apiKey: z.boolean(),
  diarizationApiKey: z.boolean(),
  llmApiKey: z.boolean(),
  openaiRealtimeApiKey: z.boolean()
})
const noSecretsStatusSchema = z.object({})

/**
 * A Lucide icon name in kebab-case, e.g. `calendar-days`. Rendered with
 * `DynamicIcon` from `lucide-react/dynamic`.
 */
export const lucideIconNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Expected a kebab-case Lucide icon name')

const componentBaseSchema = z.object({
  name: z.string().trim().min(1).max(80),
  /** Lucide icon name. Used when `iconUrl` is null. */
  icon: lucideIconNameSchema.nullable(),
  /** Optional image override (favicon, logo). Takes precedence over `icon`. */
  iconUrl: httpsUrlSchema.nullable(),
  /**
   * Disabled components stay in the admin list but vanish, with their widgets,
   * from every sidebar, dashboard and folder.
   */
  enabled: z.boolean()
})

/**
 * What an admin sends to create or fully replace a component. Built-in types
 * (modules and desktop components, see `isBuiltInType`) cannot be created,
 * only replaced, and a component's type cannot change into or out of one.
 */
export const componentInputSchema = z.discriminatedUnion('type', [
  componentBaseSchema.extend({ type: z.literal('iframe'), config: iframeComponentConfigSchema }),
  componentBaseSchema.extend({ type: z.literal('rss'), config: rssComponentConfigSchema }),
  componentBaseSchema.extend({ type: z.literal('link'), config: linkComponentConfigSchema }),
  componentBaseSchema.extend({
    type: z.literal('translator'),
    config: translatorComponentConfigSchema,
    secrets: translatorSecretsInputSchema
  }),
  componentBaseSchema.extend({
    type: z.literal('transcription'),
    config: transcriptionComponentConfigSchema,
    secrets: transcriptionSecretsInputSchema
  }),
  componentBaseSchema.extend({ type: z.literal('files'), config: desktopComponentConfigSchema })
])
export type ComponentInput = z.infer<typeof componentInputSchema>

const storedComponentSchema = componentBaseSchema.extend({
  id: z.string().uuid(),
  /** Position in the admin catalogue and in pickers. */
  sortOrder: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
})

/** A component as the API returns it. Secrets are never part of it. */
export const componentSchema = z.discriminatedUnion('type', [
  storedComponentSchema.extend({ type: z.literal('iframe'), config: iframeComponentConfigSchema }),
  storedComponentSchema.extend({ type: z.literal('rss'), config: rssComponentConfigSchema }),
  storedComponentSchema.extend({ type: z.literal('link'), config: linkComponentConfigSchema }),
  storedComponentSchema.extend({
    type: z.literal('translator'),
    config: translatorComponentConfigSchema
  }),
  storedComponentSchema.extend({
    type: z.literal('transcription'),
    config: transcriptionComponentConfigSchema
  }),
  storedComponentSchema.extend({ type: z.literal('files'), config: desktopComponentConfigSchema })
])
export type Component = z.infer<typeof componentSchema>

export const componentListSchema = z.object({ components: z.array(componentSchema) })
export type ComponentList = z.infer<typeof componentListSchema>

/** A component as the admin endpoints return it: plus which of its secrets are set. */
export const adminComponentSchema = z.discriminatedUnion('type', [
  storedComponentSchema.extend({
    type: z.literal('iframe'),
    config: iframeComponentConfigSchema,
    secrets: noSecretsStatusSchema
  }),
  storedComponentSchema.extend({
    type: z.literal('rss'),
    config: rssComponentConfigSchema,
    secrets: noSecretsStatusSchema
  }),
  storedComponentSchema.extend({
    type: z.literal('link'),
    config: linkComponentConfigSchema,
    secrets: noSecretsStatusSchema
  }),
  storedComponentSchema.extend({
    type: z.literal('translator'),
    config: translatorComponentConfigSchema,
    secrets: translatorSecretsStatusSchema
  }),
  storedComponentSchema.extend({
    type: z.literal('transcription'),
    config: transcriptionComponentConfigSchema,
    secrets: transcriptionSecretsStatusSchema
  }),
  storedComponentSchema.extend({
    type: z.literal('files'),
    config: desktopComponentConfigSchema,
    secrets: noSecretsStatusSchema
  })
])
export type AdminComponent = z.infer<typeof adminComponentSchema>

export const adminComponentListSchema = z.object({ components: z.array(adminComponentSchema) })
export type AdminComponentList = z.infer<typeof adminComponentListSchema>

/** New catalogue order: every existing id exactly once. */
export const componentOrderSchema = z.object({
  ids: z.array(z.string().uuid()).min(1)
})
export type ComponentOrder = z.infer<typeof componentOrderSchema>

// ---------------------------------------------------------------------------
// Widgets (what a component adds to the dashboard, fixed in code per type)
// ---------------------------------------------------------------------------

/** Size limits of one widget, in grid cells. Tiles cannot shrink below the minimum. */
export interface WidgetDefinition {
  minW: number
  minH: number
}

/**
 * The widgets each component type adds, keyed by widget key. Every enabled
 * component offers all widgets of its type; there is nothing to configure per
 * widget. `iframe.launcher` opens the page, `rss.feed` lists the newest
 * entries, `link.shortcut` opens the URL outside the app, `translator.quick`
 * translates a short text in place, `transcription.quick` starts a transcription (and counts the
 * running ones), `transcription.recent` lists the newest saved transcripts.
 */
export const COMPONENT_WIDGETS = {
  iframe: { launcher: { minW: TILE_MIN_W, minH: TILE_MIN_H } },
  rss: { feed: { minW: TILE_MIN_W, minH: TILE_MIN_H } },
  link: { shortcut: { minW: TILE_MIN_W, minH: TILE_MIN_H } },
  translator: { quick: { minW: 3, minH: 5 } },
  transcription: {
    quick: { minW: TILE_MIN_W, minH: TILE_MIN_H },
    recent: { minW: 3, minH: 4 }
  },
  files: {}
} as const satisfies { [T in ComponentType]: Record<string, WidgetDefinition> }

export type WidgetKey<T extends ComponentType = ComponentType> = T extends ComponentType
  ? keyof (typeof COMPONENT_WIDGETS)[T] & string
  : never

/** The definition of `key` for a component of `type`, or `undefined` if the type has no such widget. */
export function widgetDefinition(type: ComponentType, key: string): WidgetDefinition | undefined {
  const widgets: Readonly<Record<string, WidgetDefinition>> = COMPONENT_WIDGETS[type]
  return Object.hasOwn(widgets, key) ? widgets[key] : undefined
}

export const widgetKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-zA-Z0-9]*$/, 'Expected a widget key')

/**
 * Points at one widget: a component plus one of its type's widget keys.
 * Schemas only check the shape; the server checks that the key belongs to the
 * component's type.
 */
export const widgetRefSchema = z.object({
  componentId: z.string().uuid(),
  widgetKey: widgetKeySchema
})
export type WidgetRef = z.infer<typeof widgetRefSchema>

/** A stable string for a widget reference, for sets and React keys. */
export function widgetRefKey(ref: WidgetRef): string {
  return `${ref.componentId}:${ref.widgetKey}`
}

/** A widget as the API lists it: derived from the enabled components and `COMPONENT_WIDGETS`. */
export const widgetSchema = widgetRefSchema.extend({
  minW: z.number().int().min(TILE_MIN_W).max(DASHBOARD_COLS),
  minH: z.number().int().min(TILE_MIN_H).max(TILE_MAX_H)
})
export type Widget = z.infer<typeof widgetSchema>

export const widgetListSchema = z.object({ widgets: z.array(widgetSchema) })
export type WidgetList = z.infer<typeof widgetListSchema>

// ---------------------------------------------------------------------------
// Sidebar (per user: which components, in which order)
// ---------------------------------------------------------------------------

export const sidebarSchema = z.object({
  /** Component ids in display order. Only enabled components are returned. */
  componentIds: z.array(z.string().uuid())
})
export type Sidebar = z.infer<typeof sidebarSchema>

/** Replaces the whole sidebar. Duplicates are rejected. */
export const sidebarPutSchema = sidebarSchema.refine(
  ({ componentIds }) => new Set(componentIds).size === componentIds.length,
  { message: 'A component can appear in the sidebar only once' }
)

// ---------------------------------------------------------------------------
// Dashboard (per user: a free grid of tiles)
// ---------------------------------------------------------------------------

const tileGeometrySchema = z.object({
  /** Client-generated UUID, stable across saves. */
  id: z.string().uuid(),
  x: z
    .number()
    .int()
    .min(0)
    .max(DASHBOARD_COLS - TILE_MIN_W),
  y: z.number().int().min(0),
  w: z.number().int().min(TILE_MIN_W).max(DASHBOARD_COLS),
  h: z.number().int().min(TILE_MIN_H).max(TILE_MAX_H)
})

const fitsGrid = { message: 'Tile exceeds the grid width' }
const insideGrid = (tile: { x: number; w: number }): boolean => tile.x + tile.w <= DASHBOARD_COLS

/** A tile showing one widget. One widget may appear in several tiles. */
export const widgetTileSchema = tileGeometrySchema
  .extend({ kind: z.literal('widget'), ...widgetRefSchema.shape })
  .refine(insideGrid, fitsGrid)
export type WidgetTile = z.infer<typeof widgetTileSchema>

export const FOLDER_TITLE_MAX = 40
/** Longest title of a personal shortcut or feed tile. */
export const TILE_TITLE_MAX = 80

/**
 * A user's own shortcut to any URL. It opens outside the app. With `icon`
 * null the site's favicon is shown, falling back to a generic link icon.
 */
const shortcutFields = {
  /** Client-generated UUID. */
  id: z.string().uuid(),
  title: z.string().trim().min(1).max(TILE_TITLE_MAX),
  url: externalUrlSchema,
  icon: lucideIconNameSchema.nullable()
}

/** A shortcut as a tile of its own. */
export const linkTileSchema = tileGeometrySchema
  .extend({ kind: z.literal('link'), ...shortcutFields })
  .refine(insideGrid, fitsGrid)
export type LinkTile = z.infer<typeof linkTileSchema>

/** A tile listing the newest entries of any RSS, Atom or JSON feed the user chose. */
export const feedTileSchema = tileGeometrySchema
  .extend({
    kind: z.literal('feed'),
    /** `null` shows the feed's own title. */
    title: z.string().trim().min(1).max(TILE_TITLE_MAX).nullable(),
    feedUrl: externalUrlSchema
  })
  .refine(insideGrid, fitsGrid)
export type FeedTile = z.infer<typeof feedTileSchema>

/** One entry of a folder: a widget or a personal shortcut. */
export const folderItemSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('widget'), ...widgetRefSchema.shape }),
  z.object({ kind: z.literal('link'), ...shortcutFields })
])
export type FolderItem = z.infer<typeof folderItemSchema>
export type FolderLinkItem = Extract<FolderItem, { kind: 'link' }>

function uniqueFolderItems(items: readonly FolderItem[]): boolean {
  const keys = items.map((item) =>
    item.kind === 'widget' ? `widget:${widgetRefKey(item)}` : `link:${item.id}`
  )
  return new Set(keys).size === keys.length
}

/** A tile holding widgets and shortcuts, shown as a folder of small icons. */
export const folderTileSchema = tileGeometrySchema
  .extend({
    kind: z.literal('folder'),
    title: z.string().trim().min(1).max(FOLDER_TITLE_MAX),
    /** Lucide icon shown next to the title; absent or null shows a folder icon. */
    icon: lucideIconNameSchema.nullable().optional(),
    /** Contents in display order; each widget and each shortcut id at most once. */
    items: z.array(folderItemSchema).refine(uniqueFolderItems, {
      message: 'A widget or shortcut can be in a folder only once'
    })
  })
  .refine(insideGrid, fitsGrid)
export type FolderTile = z.infer<typeof folderTileSchema>

export const DASHBOARD_TILE_KINDS = ['widget', 'folder', 'link', 'feed'] as const

export const dashboardTileSchema = z.discriminatedUnion('kind', [
  widgetTileSchema,
  folderTileSchema,
  linkTileSchema,
  feedTileSchema
])
export type DashboardTile = z.infer<typeof dashboardTileSchema>

export const dashboardSchema = z.object({
  /** Widget tiles of disabled components are left out; folders list only enabled widgets and shortcuts. */
  tiles: z.array(dashboardTileSchema)
})
export type Dashboard = z.infer<typeof dashboardSchema>

/** Replaces the whole dashboard. Tile ids and folder shortcut ids must be unique. */
export const dashboardPutSchema = dashboardSchema
  .refine(({ tiles }) => new Set(tiles.map((tile) => tile.id)).size === tiles.length, {
    message: 'Tile ids must be unique'
  })
  .refine(
    ({ tiles }) => {
      const ids = tiles.flatMap((tile) =>
        tile.kind === 'folder'
          ? tile.items.flatMap((item) => (item.kind === 'link' ? [item.id] : []))
          : []
      )
      return new Set(ids).size === ids.length
    },
    { message: 'A shortcut can be in only one folder' }
  )

// ---------------------------------------------------------------------------
// Folder templates (admin-defined folders users can add to their dashboard)
// ---------------------------------------------------------------------------

/**
 * A folder an admin predefines. Adding it to a dashboard copies it into an
 * ordinary folder tile (title, icon, widgets); later changes to the template
 * do not reach existing copies.
 */
export const folderTemplateInputSchema = z.object({
  name: z.string().trim().min(1).max(FOLDER_TITLE_MAX),
  icon: lucideIconNameSchema.nullable(),
  /** Disabled templates stay in the admin list but are not offered to users. */
  enabled: z.boolean(),
  /** Widgets in display order, each at most once. */
  widgets: z
    .array(widgetRefSchema)
    .refine((refs) => new Set(refs.map(widgetRefKey)).size === refs.length, {
      message: 'A widget can be in a folder only once'
    })
})
export type FolderTemplateInput = z.infer<typeof folderTemplateInputSchema>

/** A template as the API returns it. The user endpoint lists only widgets of enabled components. */
export const folderTemplateSchema = folderTemplateInputSchema.extend({
  id: z.string().uuid(),
  sortOrder: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
})
export type FolderTemplate = z.infer<typeof folderTemplateSchema>

export const folderTemplateListSchema = z.object({ folders: z.array(folderTemplateSchema) })
export type FolderTemplateList = z.infer<typeof folderTemplateListSchema>

/** New template order: every existing template id exactly once. */
export const folderTemplateOrderSchema = componentOrderSchema
export type FolderTemplateOrder = z.infer<typeof folderTemplateOrderSchema>

// ---------------------------------------------------------------------------
// Layout presets (admin-defined starting sidebar and dashboard)
// ---------------------------------------------------------------------------

/**
 * Who a preset is for: everyone holding a Keycloak realm role, every member of
 * a Keycloak group (full path, e.g. `/Studierende`), or everyone as the
 * fallback. At most one `everyone` preset exists.
 */
export const presetAudienceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('role'), name: z.string().trim().min(1).max(255) }),
  z.object({ kind: z.literal('group'), name: z.string().trim().min(1).max(255) }),
  z.object({ kind: z.literal('everyone') })
])
export type PresetAudience = z.infer<typeof presetAudienceSchema>

/**
 * A starting sidebar and dashboard. On a user's first sign-in the server walks
 * the presets in `sortOrder`, takes the first whose role or group the user
 * has, else the `everyone` preset, and copies it once into the user's own
 * sidebar and dashboard (fresh tile ids, widgets of disabled or deleted
 * components dropped). Later changes to presets never reach existing users.
 */
export const layoutPresetInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  audience: presetAudienceSchema,
  sidebar: sidebarPutSchema,
  dashboard: dashboardPutSchema
})
export type LayoutPresetInput = z.infer<typeof layoutPresetInputSchema>

export const layoutPresetSchema = layoutPresetInputSchema.extend({
  id: z.string().uuid(),
  /** Match priority, lowest first. The `everyone` preset is always tried last. */
  sortOrder: z.number().int(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
})
export type LayoutPreset = z.infer<typeof layoutPresetSchema>

export const layoutPresetListSchema = z.object({ presets: z.array(layoutPresetSchema) })
export type LayoutPresetList = z.infer<typeof layoutPresetListSchema>

/** New match priority: every existing preset id exactly once. */
export const layoutPresetOrderSchema = componentOrderSchema
export type LayoutPresetOrder = z.infer<typeof layoutPresetOrderSchema>

/** Role and group names seen at users' sign-ins, sorted, for the audience picker. */
export const presetAudienceSuggestionsSchema = z.object({
  roles: z.array(z.string()),
  groups: z.array(z.string())
})
export type PresetAudienceSuggestions = z.infer<typeof presetAudienceSuggestionsSchema>

// ---------------------------------------------------------------------------
// Feeds (fetched and normalised by the server, see `API.feed`)
// ---------------------------------------------------------------------------

/** Most entries `API.feed` returns, newest first when the feed has dates. */
export const FEED_MAX_ITEMS = 50
export const FEED_SUMMARY_MAX = 500

/** `GET API.feed?url=…` */
export const feedQuerySchema = z.object({ url: externalUrlSchema })
export type FeedQuery = z.infer<typeof feedQuerySchema>

export const feedItemSchema = z.object({
  /** The entry's guid/id, else its link, else a hash of its title; unique within the feed. */
  id: z.string(),
  /** Plain text; entries without a title get a shortened summary instead. */
  title: z.string(),
  /** Absolute `http(s)` URL, resolved against the feed URL; `null` when missing or unsafe. */
  link: externalUrlSchema.nullable(),
  publishedAt: z.string().datetime().nullable(),
  /** Plain text without markup, at most `FEED_SUMMARY_MAX` characters. */
  summary: z.string().max(FEED_SUMMARY_MAX).nullable()
})
export type FeedItem = z.infer<typeof feedItemSchema>

export const feedSchema = z.object({
  /** The feed's own title, plain text. */
  title: z.string().nullable(),
  /** The site the feed belongs to, absolute `http(s)`. */
  link: externalUrlSchema.nullable(),
  items: z.array(feedItemSchema).max(FEED_MAX_ITEMS),
  fetchedAt: z.string().datetime()
})
export type Feed = z.infer<typeof feedSchema>

/**
 * `GET API.feed`: the feed plus when the current user last read it. Entries
 * published after `readAt` are unread; `null` means the user never read this
 * feed, so nothing counts as unread yet.
 */
export const userFeedSchema = feedSchema.extend({
  readAt: z.string().datetime().nullable()
})
export type UserFeed = z.infer<typeof userFeedSchema>

/**
 * `PUT API.feedRead`: the user read the feed as of `readAt` (the `fetchedAt`
 * of the copy they saw). The server keeps the later of the stored and the
 * sent time, so it never moves back.
 */
export const feedReadPutSchema = z.object({
  url: externalUrlSchema,
  readAt: z.string().datetime()
})
export type FeedReadPut = z.infer<typeof feedReadPutSchema>

// ---------------------------------------------------------------------------
// Translator module (`API.translator*`)
// ---------------------------------------------------------------------------

/** Characters a text may have in the translator (HAWKI's limit). */
export const TRANSLATE_TEXT_MAX = 50_000
/** Sentences one request may carry; the text is sent split into sentences. */
export const TRANSLATE_SEGMENTS_MAX = 5000

export const TRANSLATOR_ENGINE_KINDS = ['deepl', 'llm'] as const
export type TranslatorEngineKind = (typeof TRANSLATOR_ENGINE_KINDS)[number]

export const translatorEngineSchema = z.object({
  id: translatorEngineIdSchema,
  kind: z.enum(TRANSLATOR_ENGINE_KINDS),
  label: z.string()
})
export type TranslatorEngine = z.infer<typeof translatorEngineSchema>

/**
 * The engines users may pick, DeepL first, then the models in admin order.
 * `defaultEngine` is the admin's choice if it is offered, else the first
 * engine; `null` only when there is none (the module lacks its settings).
 * `llmProvider` names the group the models are listed under.
 */
export const translatorEngineListSchema = z.object({
  engines: z.array(translatorEngineSchema),
  defaultEngine: translatorEngineIdSchema.nullable(),
  /** Whether documents can be translated: `documentsEnabled` and a DeepL key. */
  documents: z.boolean(),
  /** The provider of the AI models as the admin named it; `null`: unnamed. */
  llmProvider: z.string().nullable().default(null)
})
export type TranslatorEngineList = z.infer<typeof translatorEngineListSchema>

/**
 * Asks an OpenAI-compatible endpoint which models it offers, for the admin
 * form. `apiKey` is the key as typed in the form: a string uses it, `null`
 * sends none, left out uses the saved `llmApiKey`.
 */
export const translatorModelsRequestSchema = z.object({
  baseUrl: httpsUrlSchema,
  apiKey: z.string().trim().min(1).max(SECRET_VALUE_MAX).nullable().optional()
})
export type TranslatorModelsRequest = z.infer<typeof translatorModelsRequestSchema>

/**
 * The endpoint's chat models in its order, labelled with the name it gives
 * them, else their id. Embedding, speech and image models are left out.
 */
export const translatorModelListSchema = z.object({
  models: z.array(translatorLlmModelSchema)
})
export type TranslatorModelList = z.infer<typeof translatorModelListSchema>

/**
 * Formal or informal address ("Sie" or "du"). DeepL applies it where the
 * target language has the distinction and ignores it elsewhere.
 */
export const TRANSLATOR_FORMALITIES = ['default', 'formal', 'informal'] as const
export const translatorFormalitySchema = z.enum(TRANSLATOR_FORMALITIES)
export type TranslatorFormality = z.infer<typeof translatorFormalitySchema>

/** Writing styles; DeepL Write's `writing_style` values. */
export const REPHRASE_STYLES = ['business', 'academic', 'casual', 'simple'] as const
export const rephraseStyleSchema = z.enum(REPHRASE_STYLES)
export type RephraseStyle = z.infer<typeof rephraseStyleSchema>

/** Tones; DeepL Write's `tone` values. */
export const REPHRASE_TONES = ['confident', 'diplomatic', 'enthusiastic', 'friendly'] as const
export const rephraseToneSchema = z.enum(REPHRASE_TONES)
export type RephraseTone = z.infer<typeof rephraseToneSchema>

/** Glossaries one request may apply. */
export const TRANSLATOR_GLOSSARIES_PER_REQUEST_MAX = 20

/**
 * A text as its sentences, in order, each with the whitespace that follows it: joined they give
 * the text back. Engines answer sentence by sentence, so a result lines up with its source.
 */
const translatorSegmentsSchema = z
  .array(z.string().max(TRANSLATE_TEXT_MAX))
  .min(1)
  .max(TRANSLATE_SEGMENTS_MAX)
  .refine((segments) => segments.some((segment) => segment.trim()), {
    message: 'Enter a text'
  })
  .refine(
    (segments) => segments.reduce((sum, segment) => sum + segment.length, 0) <= TRANSLATE_TEXT_MAX,
    {
      message: `At most ${TRANSLATE_TEXT_MAX} characters`
    }
  )

/** Style, tone and formality: one of them at most, as the style panel chooses them. */
const translatorAdjustmentFields = {
  formality: translatorFormalitySchema.default('default'),
  style: rephraseStyleSchema.nullable().default(null),
  tone: rephraseToneSchema.nullable().default(null)
}

const glossaryIdsSchema = z.array(z.uuid()).max(TRANSLATOR_GLOSSARIES_PER_REQUEST_MAX).default([])

export const translateRequestSchema = z.object({
  text: translatorSegmentsSchema,
  /** `null` lets the service detect the language. */
  source: translatorLanguageSchema.nullable(),
  target: translatorLanguageSchema,
  /** Left out: the default engine. */
  engine: translatorEngineIdSchema.optional(),
  ...translatorAdjustmentFields,
  /** Glossaries whose terms the translation keeps to (see `API.translatorGlossaries`). */
  glossaryIds: glossaryIdsSchema
})
export type TranslateRequest = z.input<typeof translateRequestSchema>

export const translateResponseSchema = z.object({
  /** One translation per sentence of the request, in its order. */
  text: z.array(z.string()),
  /** The language the service detected when `source` was `null`, if it could tell. */
  detectedSource: translatorLanguageSchema.nullable()
})
export type TranslateResponse = z.infer<typeof translateResponseSchema>

/**
 * Rewrites a text in its own language: corrects it and, if asked, adapts it
 * to a style, a tone or a formality. `language` is the text's language when it is known.
 */
export const rephraseRequestSchema = z.object({
  text: translatorSegmentsSchema,
  language: translatorLanguageSchema.nullable().default(null),
  engine: translatorEngineIdSchema.optional(),
  ...translatorAdjustmentFields,
  glossaryIds: glossaryIdsSchema
})
export type RephraseRequest = z.input<typeof rephraseRequestSchema>

export const rephraseResponseSchema = z.object({
  /** One sentence per sentence of the request, in its order. */
  text: z.array(z.string()),
  /** The language of the text, if the service tells. */
  detectedLanguage: translatorLanguageSchema.nullable()
})
export type RephraseResponse = z.infer<typeof rephraseResponseSchema>

/** Characters language detection looks at: the start of the text is enough. */
export const TRANSLATOR_DETECT_SAMPLE_MAX = 500

/** Detects the language of a text before it is translated. */
export const translatorDetectRequestSchema = z.object({
  text: z.string().trim().min(1).max(TRANSLATOR_DETECT_SAMPLE_MAX),
  /** The engine chosen; an AI model detects with itself, DeepL with the first model, else DeepL. */
  engine: translatorEngineIdSchema.optional()
})
export type TranslatorDetectRequest = z.input<typeof translatorDetectRequestSchema>

export const translatorDetectResponseSchema = z.object({
  /** `null`: not a language the translator offers, or not recognisable. */
  language: translatorLanguageSchema.nullable()
})
export type TranslatorDetectResponse = z.infer<typeof translatorDetectResponseSchema>

/**
 * What a click on a result offers: other wordings of a sentence (`alternatives`), other words for
 * one word in its sentence (`synonyms`, the word marked `[[TARGET]]` in `context`), or the sentence
 * corrected after a word in it was replaced (`correction`, the old sentence in `context`).
 */
export const TRANSLATOR_SUGGESTION_KINDS = ['alternatives', 'synonyms', 'correction'] as const
export type TranslatorSuggestionKind = (typeof TRANSLATOR_SUGGESTION_KINDS)[number]

export const TRANSLATOR_SUGGESTION_TEXT_MAX = 2000

export const translatorSuggestRequestSchema = z.object({
  kind: z.enum(TRANSLATOR_SUGGESTION_KINDS),
  text: z.string().trim().min(1).max(TRANSLATOR_SUGGESTION_TEXT_MAX),
  context: z
    .string()
    .max(TRANSLATOR_SUGGESTION_TEXT_MAX * 2)
    .nullable()
    .default(null),
  /** The language of `text`, if known. */
  language: translatorLanguageSchema.nullable().default(null),
  engine: translatorEngineIdSchema.optional(),
  ...translatorAdjustmentFields,
  /** Suggestions already shown, which the answer must not repeat. */
  exclusions: z.array(z.string().max(TRANSLATOR_SUGGESTION_TEXT_MAX)).max(50).default([])
})
export type TranslatorSuggestRequest = z.input<typeof translatorSuggestRequestSchema>

export const translatorSuggestResponseSchema = z.object({
  suggestions: z.array(z.string())
})
export type TranslatorSuggestResponse = z.infer<typeof translatorSuggestResponseSchema>

/**
 * What the AI editor ("Text erstellen") does with the marked passage, or with the whole document
 * when nothing is marked (`compose` then writes new text from `instruction`).
 */
export const TRANSLATOR_COMPOSE_ACTIONS = [
  'proofread',
  'rephrase',
  'key_points',
  'paraphrase',
  'shorten',
  'expand',
  'list',
  'table',
  'compose'
] as const
export const translatorComposeActionSchema = z.enum(TRANSLATOR_COMPOSE_ACTIONS)
export type TranslatorComposeAction = z.infer<typeof translatorComposeActionSchema>

export const TRANSLATOR_COMPOSE_INSTRUCTION_MAX = 1000

export const translatorComposeRequestSchema = z.object({
  action: translatorComposeActionSchema,
  /**
   * The passage as Markdown; empty when composing into an empty document. As in HAWKI, there is
   * no limit of its own: the editor sends whatever is selected.
   */
  text: z.string(),
  /** What to do with it, as the menu or the user put it. */
  instruction: z.string().trim().min(1).max(TRANSLATOR_COMPOSE_INSTRUCTION_MAX),
  /** An AI model; DeepL cannot compose (`400 validation`). */
  engine: translatorEngineIdSchema.optional(),
  /**
   * HAWKI's web search, on unless the user switched it off: the web pages the instruction links
   * to are read and given to the model.
   */
  webSearch: z.boolean().default(false),
  ...translatorAdjustmentFields
})
export type TranslatorComposeRequest = z.input<typeof translatorComposeRequestSchema>

export const translatorComposeResponseSchema = z.object({
  /** The new passage as Markdown. */
  text: z.string()
})
export type TranslatorComposeResponse = z.infer<typeof translatorComposeResponseSchema>

/**
 * A Python code block of the AI editor to run ("Code ausführen"), as the block's text. Of any
 * length, as HAWKI takes it: code over 256 KB is answered, not refused.
 */
export const translatorPythonRequestSchema = z.object({
  code: z.string()
})
export type TranslatorPythonRequest = z.input<typeof translatorPythonRequestSchema>

/**
 * How the run ended, as HAWKI answers it. `success`: the code exited with 0; `output` is then what
 * it printed. Otherwise `output` is the error output, `\n---\n` and what was printed (only the
 * printed text when there was no error output), or the timeout message. Each of the two outputs
 * ends after 512 KiB with `\n[truncated]`, which also stops the run.
 */
export const translatorPythonResponseSchema = z.object({
  success: z.boolean(),
  output: z.string()
})
export type TranslatorPythonResponse = z.infer<typeof translatorPythonResponseSchema>

/** Languages glossary terms are in, as their codes in the glossary forms. */
export const TRANSLATOR_GLOSSARY_LANGUAGES = ['de', 'en', 'uk', 'fr', 'es', 'it'] as const
export const translatorGlossaryLanguageSchema = z.enum(TRANSLATOR_GLOSSARY_LANGUAGES)
export type TranslatorGlossaryLanguage = z.infer<typeof translatorGlossaryLanguageSchema>

/**
 * Who sees a glossary: its owner, the users of one role (`organization`, HAWKI's "Organisation"),
 * or everyone.
 */
export const TRANSLATOR_GLOSSARY_VISIBILITIES = ['private', 'organization', 'public'] as const
export const translatorGlossaryVisibilitySchema = z.enum(TRANSLATOR_GLOSSARY_VISIBILITIES)
export type TranslatorGlossaryVisibility = z.infer<typeof translatorGlossaryVisibilitySchema>

/**
 * The roles a glossary is shared with or edited by: HAWKI's, by their slugs, in its order. Which
 * Campus users hold one is told by their Keycloak roles and groups (`glossaryRoles` on the server).
 */
export const TRANSLATOR_GLOSSARY_ROLES = [
  'admin',
  'student',
  'lecturer',
  'staff',
  'guest',
  'mod'
] as const
export const translatorGlossaryRoleSchema = z.enum(TRANSLATOR_GLOSSARY_ROLES)
export type TranslatorGlossaryRole = z.infer<typeof translatorGlossaryRoleSchema>

/** The names the roles show under, in either language, as HAWKI's role table has them. */
export const TRANSLATOR_GLOSSARY_ROLE_NAMES: Record<TranslatorGlossaryRole, string> = {
  admin: 'Administrator',
  student: 'Studierende',
  lecturer: 'Lehrende',
  staff: 'Mitarbeiter',
  guest: 'Gast',
  mod: 'Moderator'
}

/** A new glossary's category, as in HAWKI. */
export const TRANSLATOR_GLOSSARY_DEFAULT_CATEGORY = 'general'

/**
 * HAWKI's limits: a name and a category of up to 255 characters, a new glossary's name of up to
 * 241 (with its 14-character suffix it fills 255). Description and terms are MySQL `TEXT`, which
 * ends after 65,535 bytes of UTF-8.
 */
export const TRANSLATOR_GLOSSARY_NAME_MAX = 255
export const TRANSLATOR_GLOSSARY_NEW_NAME_MAX = 241
export const TRANSLATOR_GLOSSARY_CATEGORY_MAX = 255
/** HAWKI's message for a name or a category over 255 characters, which its page shows as is. */
export const TRANSLATOR_GLOSSARY_TOO_LONG = 'validation.max.string'
export const TRANSLATOR_GLOSSARY_TEXT_MAX_BYTES = 65_535
/** Size of a CSV file to import, as in HAWKI (5,120 KB); a file of any number of pairs fits. */
export const TRANSLATOR_GLOSSARY_IMPORT_MAX_BYTES = 5 * 1024 * 1024
/** HAWKI's message for a larger CSV file, which its page shows as it is. */
export const TRANSLATOR_GLOSSARY_IMPORT_TOO_LARGE = 'The file must not exceed 5MB.'

/** A name or a category: at most `max` characters, counted as HAWKI counts them (code points). */
function glossaryField(max: number, min = 0) {
  return z
    .string()
    .trim()
    .min(min)
    .refine((value) => [...value].length <= max, { message: TRANSLATOR_GLOSSARY_TOO_LONG })
}

/** A string of at least `min` characters and at most `TRANSLATOR_GLOSSARY_TEXT_MAX_BYTES` bytes. */
function glossaryText(min = 0) {
  return z
    .string()
    .trim()
    .min(min)
    .refine(
      (value) => new TextEncoder().encode(value).length <= TRANSLATOR_GLOSSARY_TEXT_MAX_BYTES,
      {
        message: 'Too long'
      }
    )
}

/** One term and how it is translated. */
export const translatorGlossaryEntrySchema = z.object({
  sourceLanguage: translatorGlossaryLanguageSchema,
  sourceTerm: glossaryText(1),
  targetLanguage: translatorGlossaryLanguageSchema,
  targetTerm: glossaryText(1)
})
export type TranslatorGlossaryEntry = z.infer<typeof translatorGlossaryEntrySchema>

/**
 * A glossary the current user can use: their own, a public one, or one shared with a role of
 * theirs. Its owner and the users of its `editorRole` edit it and change who sees it, as in
 * HAWKI; only the owner deletes it.
 */
export const translatorGlossarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string(),
  /** Free text, shown in capitals; `general` unless changed. */
  category: z.string(),
  visibility: translatorGlossaryVisibilitySchema,
  /** The role that sees an `organization` glossary; none: only its owner. */
  visibleTo: translatorGlossaryRoleSchema.nullable(),
  /** The role whose users edit it besides the owner; none: the owner only. */
  editorRole: translatorGlossaryRoleSchema.nullable(),
  entryCount: z.number().int().nonnegative(),
  /** Name of the user who created it. */
  creatorName: z.string(),
  canEdit: z.boolean(),
  canDelete: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime()
})
export type TranslatorGlossary = z.infer<typeof translatorGlossarySchema>

/** The glossaries the current user can use: public ones and their own, by name. */
export const translatorGlossaryListSchema = z.object({
  glossaries: z.array(translatorGlossarySchema),
  /** The roles a glossary can be shared with or edited by: all of HAWKI's, in its order. */
  roles: z.array(translatorGlossaryRoleSchema)
})
export type TranslatorGlossaryList = z.infer<typeof translatorGlossaryListSchema>

export const translatorGlossaryDetailSchema = translatorGlossarySchema.extend({
  entries: z.array(translatorGlossaryEntrySchema)
})
export type TranslatorGlossaryDetail = z.infer<typeof translatorGlossaryDetailSchema>

/**
 * A new glossary, or all of an edited one. An empty description leaves an edited glossary's as it
 * was, as in HAWKI; its roles stay too. As in HAWKI, a glossary takes any number of terms.
 */
export const translatorGlossaryInputSchema = z.object({
  name: glossaryField(TRANSLATOR_GLOSSARY_NAME_MAX, 1),
  description: glossaryText().default(''),
  visibility: translatorGlossaryVisibilitySchema.default('private'),
  entries: z.array(translatorGlossaryEntrySchema).min(1)
})
export type TranslatorGlossaryInput = z.input<typeof translatorGlossaryInputSchema>

/**
 * Changes the details view makes: description and category, or who sees and edits the glossary.
 * An empty description or category leaves it as it was, as in HAWKI. `visibleTo` counts for
 * `organization` only and `editorRole` not for `private`; both are dropped otherwise.
 */
export const translatorGlossaryPatchSchema = z
  .object({
    description: glossaryText().optional(),
    category: glossaryField(TRANSLATOR_GLOSSARY_CATEGORY_MAX).optional(),
    visibility: translatorGlossaryVisibilitySchema.optional(),
    visibleTo: translatorGlossaryRoleSchema.nullable().optional(),
    editorRole: translatorGlossaryRoleSchema.nullable().optional()
  })
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: 'Change the description, the category or the rights'
  })
export type TranslatorGlossaryPatch = z.infer<typeof translatorGlossaryPatchSchema>

/**
 * The fields of `POST API.translatorGlossaryImport` besides `file` (multipart form data): a CSV
 * of two columns, the source term and the target term, one pair per line.
 */
export const translatorGlossaryImportSchema = z.object({
  name: glossaryField(TRANSLATOR_GLOSSARY_NAME_MAX, 1),
  description: glossaryText().default(''),
  sourceLanguage: translatorGlossaryLanguageSchema,
  targetLanguage: translatorGlossaryLanguageSchema
})
export type TranslatorGlossaryImport = z.input<typeof translatorGlossaryImportSchema>

/**
 * The term pairs of a CSV glossary: two columns, comma or semicolon separated, quotes as in
 * RFC 4180. Blank lines are skipped; a line with fewer than two terms makes the file invalid
 * (`null`), and so does a file without any pair.
 */
export function parseGlossaryCsv(
  content: string
): Array<{ source: string; target: string }> | null {
  const text = content.replace(/^﻿/, '')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const delimiter = /^[^\n]*;/.test(text) && !/^[^\n]*,/.test(text) ? ';' : ','
  const endField = (): void => {
    row.push(field)
    field = ''
  }
  const endRow = (): void => {
    endField()
    rows.push(row)
    row = []
  }
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"'
        index++
      } else if (character === '"') quoted = false
      else field += character
    } else if (character === '"' && field === '') quoted = true
    else if (character === delimiter) endField()
    else if (character === '\n') endRow()
    else if (character !== '\r') field += character
  }
  if (field || row.length > 0) endRow()
  const pairs: Array<{ source: string; target: string }> = []
  for (const cells of rows) {
    const values = cells.map((cell) => cell.trim())
    if (values.every((value) => !value)) continue
    const [source, target] = values
    if (!source || !target) return null
    pairs.push({ source, target })
  }
  return pairs.length > 0 ? pairs : null
}

/**
 * Document translation goes through DeepL's document API. The server uploads
 * the file straight to DeepL (it keeps no copy of the original), follows the
 * job until it is done, and keeps the translated file for
 * `TRANSLATOR_DOCUMENT_TTL_HOURS`, so a user can download it again, also
 * after closing the tab. Pictures are translated too.
 */
export const TRANSLATOR_DOCUMENT_EXTENSIONS = [
  'pdf',
  'doc',
  'docx',
  'pptx',
  'ppt',
  'xlsx',
  'xls',
  'txt',
  'htm',
  'html',
  'xlf',
  'xliff',
  'srt',
  'jpg',
  'jpeg',
  'png'
] as const
export type TranslatorDocumentExtension = (typeof TRANSLATOR_DOCUMENT_EXTENSIONS)[number]
export const TRANSLATOR_DOCUMENT_MAX_BYTES = 20 * 1024 * 1024
/** The issue on `file` for a document over `TRANSLATOR_DOCUMENT_MAX_BYTES`, however large. */
export const TRANSLATOR_DOCUMENT_TOO_LARGE = 'File is too large'
export const TRANSLATOR_DOCUMENT_TTL_HOURS = 24
export const TRANSLATOR_DOCUMENT_FILENAME_MAX = 255
/**
 * Jobs one user may have queued or translating at once: a guard against runaway uploads only.
 * HAWKI takes several parallel jobs (tabs) of one user, so normal use never meets it.
 */
export const TRANSLATOR_DOCUMENT_ACTIVE_MAX = 20

/**
 * HAWKI's throttle: one count of a user's requests per minute for translating, rewriting,
 * detecting, the AI editor and Python runs as well as document uploads. The minute opens with
 * the user's first request; a request is refused (`429 rate_limited` with
 * `TRANSLATOR_THROTTLED_MESSAGE`) once the count reaches its route's limit, and refused requests
 * do not count. The answers carry `X-RateLimit-Limit` and `X-RateLimit-Remaining`, refusals also
 * `Retry-After` and `X-RateLimit-Reset`.
 */
export const TRANSLATOR_REQUESTS_PER_MINUTE = 60
/** The limit of a document upload on the same count: ten requests of any kind in the minute. */
export const TRANSLATOR_DOCUMENT_UPLOADS_PER_MINUTE = 10
/** HAWKI's (Laravel's) message for a throttled request, which its pages show as it is. */
export const TRANSLATOR_THROTTLED_MESSAGE = 'Too Many Attempts.'

/** The file's extension if it is one the translator takes, else `null`. */
export function translatorDocumentExtension(filename: string): TranslatorDocumentExtension | null {
  const extension = filename.split('.').pop()?.toLowerCase() ?? ''
  return filename.includes('.') &&
    (TRANSLATOR_DOCUMENT_EXTENSIONS as readonly string[]).includes(extension)
    ? (extension as TranslatorDocumentExtension)
    : null
}

/** DeepL's job states; `error` carries `translatorDocumentSchema.error`. */
export const TRANSLATOR_DOCUMENT_STATUSES = ['queued', 'translating', 'done', 'error'] as const
export const translatorDocumentStatusSchema = z.enum(TRANSLATOR_DOCUMENT_STATUSES)
export type TranslatorDocumentStatus = z.infer<typeof translatorDocumentStatusSchema>

/** Why a job failed: source and target language are the same, or anything else. */
export const TRANSLATOR_DOCUMENT_ERRORS = ['same_language', 'failed'] as const
export const translatorDocumentErrorSchema = z.enum(TRANSLATOR_DOCUMENT_ERRORS)
export type TranslatorDocumentError = z.infer<typeof translatorDocumentErrorSchema>

/**
 * The fields of `POST API.translatorDocuments` besides `file` (multipart form
 * data, so every value is a string; `source` empty or absent: detect;
 * `glossaryId` once per glossary).
 */
export const translatorDocumentUploadSchema = z.object({
  source: z
    .union([z.literal(''), translatorLanguageSchema])
    .optional()
    .transform((value) => value || null),
  target: translatorLanguageSchema,
  formality: translatorFormalitySchema.default('default'),
  glossaryIds: glossaryIdsSchema
})
export type TranslatorDocumentUpload = z.input<typeof translatorDocumentUploadSchema>

/** One of the current user's document jobs. */
export const translatorDocumentSchema = z.object({
  id: z.string().uuid(),
  /** The uploaded file's name. */
  filename: z.string(),
  /** Size of the uploaded file in bytes. */
  size: z.number().int().nonnegative(),
  /** `null`: DeepL detected it. Codes as stored, also those of older releases. */
  source: z.string().nullable(),
  target: z.string(),
  status: translatorDocumentStatusSchema,
  /** DeepL's estimate while translating, if it gave one. */
  secondsRemaining: z.number().int().nonnegative().nullable(),
  /** Set when `status` is `error`. */
  error: translatorDocumentErrorSchema.nullable(),
  /** DeepL's own words for the error, if it gave any (in English). */
  errorMessage: z.string().nullable().default(null),
  /** The name the download gets, e.g. `Bericht_en-gb.docx`. */
  resultFilename: z.string(),
  /** Size of the translated file in bytes once it is done. */
  resultSize: z.number().int().nonnegative().nullable().default(null),
  createdAt: z.string().datetime(),
  /**
   * After this the server deletes the job and its file: `TRANSLATOR_DOCUMENT_TTL_HOURS` after
   * the upload while it runs, after the translation once it is done.
   */
  expiresAt: z.string().datetime()
})
export type TranslatorDocument = z.infer<typeof translatorDocumentSchema>

/** The user's unexpired jobs, newest first. */
export const translatorDocumentListSchema = z.object({
  documents: z.array(translatorDocumentSchema)
})
export type TranslatorDocumentList = z.infer<typeof translatorDocumentListSchema>

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const API_ERROR_CODES = [
  'unauthorized',
  'forbidden',
  'not_found',
  'validation',
  'conflict',
  /** `API.feed`: the feed host is not allowed, unreachable, too slow, too large, or not a feed. */
  'feed_unavailable',
  /** `API.module`: the module's upstream service failed or the module lacks a required secret. */
  'module_unavailable',
  /** `API.translatorDocuments`: the user has too many running jobs or uploads (429). */
  'rate_limited',
  /** A route that is declared but not built yet (501). */
  'not_implemented',
  'internal'
] as const
export const apiErrorCodeSchema = z.enum(API_ERROR_CODES)
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>

/** Every non-2xx JSON response has this shape. */
export const apiErrorSchema = z.object({
  error: z.object({
    code: apiErrorCodeSchema,
    message: z.string(),
    /** Zod issues for `validation` errors. */
    issues: z
      .array(z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string() }))
      .optional()
  })
})
export type ApiError = z.infer<typeof apiErrorSchema>

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * API paths, relative to the API origin. Better-Auth owns everything under
 * `/api/auth`; the OAuth provider id for Keycloak is `keycloak`.
 */
export const API = {
  health: '/api/health',
  auth: '/api/auth',
  /** GET: current session's user. PATCH: `mePatchSchema`. */
  me: '/api/me',
  /** GET: `componentListSchema`, enabled components only, in catalogue order. Any signed-in user. */
  components: '/api/components',
  /**
   * GET: `widgetListSchema`, every widget of every enabled component (catalogue
   * order, then `COMPONENT_WIDGETS` order). Any signed-in user.
   */
  widgets: '/api/widgets',
  /**
   * Admin only. GET: `adminComponentListSchema`, all components. POST:
   * `componentInputSchema` → 201 with `adminComponentSchema`; a module type
   * answers `409 conflict` (the server creates modules itself).
   */
  adminComponents: '/api/admin/components',
  /** Admin only. PUT: `componentOrderSchema` → 204. */
  adminComponentOrder: '/api/admin/components/order',
  /**
   * Admin only. GET (`adminComponentSchema`) / PUT (`componentInputSchema`) /
   * DELETE one component by id. Deleting a module, or changing a type into or
   * out of a module type, answers `409 conflict`.
   */
  adminComponent: (id: string) => `/api/admin/components/${id}`,
  /**
   * Base path of a module's own endpoints. Any signed-in user; while the
   * module's component is disabled every endpoint answers `404 not_found`.
   */
  module: (type: SingletonComponentType) => `/api/modules/${type}`,
  /**
   * Base path of a module's admin endpoints. Admin only; they work while the
   * module is disabled, so admins can set it up first.
   */
  adminModule: (type: SingletonComponentType) => `/api/admin/modules/${type}`,
  /**
   * Admin only. POST `translatorModelsRequestSchema` → `translatorModelListSchema`:
   * the models `GET <baseUrl>/models` lists. An unreachable endpoint, a refused
   * key or an answer that is not a model list answers `502 module_unavailable`.
   */
  adminTranslatorModels: '/api/admin/modules/translator/models',
  /** GET: `translatorEngineListSchema`. */
  translatorEngines: '/api/modules/translator/engines',
  /**
   * POST `translateRequestSchema` → `translateResponseSchema`. An engine that
   * is not offered answers `400 validation`; upstream failures and missing
   * settings answer `502 module_unavailable`; over `TRANSLATOR_REQUESTS_PER_MINUTE`
   * `429 rate_limited`.
   */
  translate: '/api/modules/translator/translate',
  /** POST `rephraseRequestSchema` → `rephraseResponseSchema`. Errors as for `translate`. */
  rephrase: '/api/modules/translator/rephrase',
  /**
   * The current user's document jobs; only while `translatorEngineListSchema.documents`,
   * else `404 not_found`. GET: `translatorDocumentListSchema`. POST: multipart form data with
   * `file` and the fields of `translatorDocumentUploadSchema` → 201 with `translatorDocumentSchema`;
   * a missing file, a type outside `TRANSLATOR_DOCUMENT_EXTENSIONS` or more than
   * `TRANSLATOR_DOCUMENT_MAX_BYTES` answers `400 validation`, DeepL refusing it
   * `502 module_unavailable`. Over `TRANSLATOR_DOCUMENT_UPLOADS_PER_MINUTE`, or with
   * `TRANSLATOR_DOCUMENT_ACTIVE_MAX` running jobs, it answers `429 rate_limited` before anything
   * goes to DeepL.
   */
  translatorDocuments: '/api/modules/translator/documents',
  /**
   * One of the current user's jobs (others' answer `404 not_found`). GET: `translatorDocumentSchema`,
   * with the status checked at DeepL if the job is still running. DELETE → 204.
   */
  translatorDocument: (id: string) => `/api/modules/translator/documents/${id}`,
  /** GET: the translated file as an attachment named `resultFilename`; before `done`, `409 conflict`. */
  translatorDocumentDownload: (id: string) => `/api/modules/translator/documents/${id}/download`,
  /** POST `translatorDetectRequestSchema` → `translatorDetectResponseSchema`. Errors as for `translate`. */
  translatorDetect: '/api/modules/translator/detect',
  /** POST `translatorSuggestRequestSchema` → `translatorSuggestResponseSchema`. Errors as for `translate`. */
  translatorSuggest: '/api/modules/translator/suggest',
  /**
   * POST `translatorComposeRequestSchema` → `translatorComposeResponseSchema`, for the AI editor.
   * DeepL, or no AI model at all, answers `400 validation`; otherwise errors as for `translate`.
   */
  translatorCompose: '/api/modules/translator/compose',
  /**
   * POST `translatorPythonRequestSchema` → `translatorPythonResponseSchema`: runs the code in a
   * container without network for at most 10 s, trimmed at both ends as HAWKI (Laravel) trims it.
   * Code over 256 KB (UTF-8) is not run: `success: false` with HAWKI's
   * `code_exec: code too large (max 256 KB)`. Code that is empty or only spaces answers
   * `400 validation` with the message `validation.required`, as HAWKI's does; over
   * `TRANSLATOR_REQUESTS_PER_MINUTE` `429 rate_limited`; no sandbox to run in
   * `502 module_unavailable`.
   */
  translatorExecutePython: '/api/modules/translator/execute-python',
  /**
   * GET: `translatorGlossaryListSchema`. POST: `translatorGlossaryInputSchema` → 201 with
   * `translatorGlossaryDetailSchema`; a `visibility` other than `private` from a user who is no
   * admin answers `403 forbidden`. A name over `TRANSLATOR_GLOSSARY_NEW_NAME_MAX` characters answers
   * `400 validation` with HAWKI's database message, as message and as issue on `name`; one over
   * `TRANSLATOR_GLOSSARY_NAME_MAX` the issue `TRANSLATOR_GLOSSARY_TOO_LONG`.
   */
  translatorGlossaries: '/api/modules/translator/glossaries',
  /**
   * POST multipart form data: `file` (CSV, at most `TRANSLATOR_GLOSSARY_IMPORT_MAX_BYTES`) and the
   * fields of `translatorGlossaryImportSchema` → 201 with `translatorGlossaryDetailSchema`. A file
   * that is not two columns of terms answers `400 validation` on `file`; names as for
   * `translatorGlossaries`.
   */
  translatorGlossaryImport: '/api/modules/translator/glossaries/import',
  /**
   * One glossary the user can use (others answer `404 not_found`). GET:
   * `translatorGlossaryDetailSchema`. PUT: `translatorGlossaryInputSchema`, PATCH:
   * `translatorGlossaryPatchSchema` → `translatorGlossaryDetailSchema`; DELETE → 204. Changing a
   * glossary the user may not edit, deleting one they do not own, or sharing it with a role or
   * everyone from a user who is no admin answers `403 forbidden`.
   */
  translatorGlossary: (id: string) => `/api/modules/translator/glossaries/${id}`,
  /** GET: `folderTemplateListSchema`, enabled templates with widgets of enabled components. Any signed-in user. */
  folderTemplates: '/api/folder-templates',
  /** Admin only. GET: all templates. POST: `folderTemplateInputSchema` → 201 with `folderTemplateSchema`. */
  adminFolderTemplates: '/api/admin/folder-templates',
  /** Admin only. PUT: `folderTemplateOrderSchema` → 204. */
  adminFolderTemplateOrder: '/api/admin/folder-templates/order',
  /** Admin only. GET / PUT (`folderTemplateInputSchema`) / DELETE one template by id. */
  adminFolderTemplate: (id: string) => `/api/admin/folder-templates/${id}`,
  /**
   * Admin only. GET: `layoutPresetListSchema` in match order (`everyone` last).
   * POST: `layoutPresetInputSchema` → 201 with `layoutPresetSchema`; a second
   * `everyone` preset answers `409 conflict`.
   */
  adminPresets: '/api/admin/presets',
  /** Admin only. PUT: `layoutPresetOrderSchema` → 204. */
  adminPresetOrder: '/api/admin/presets/order',
  /** Admin only. GET: `presetAudienceSuggestionsSchema`. */
  adminPresetAudiences: '/api/admin/presets/audiences',
  /** Admin only. GET / PUT (`layoutPresetInputSchema`) / DELETE one preset by id. */
  adminPreset: (id: string) => `/api/admin/presets/${id}`,
  /** GET / PUT `sidebarSchema` for the current user. */
  sidebar: '/api/sidebar',
  /** GET / PUT `dashboardSchema` for the current user. */
  dashboard: '/api/dashboard',
  /**
   * GET `?url=` (`feedQuerySchema`) → `userFeedSchema`. Any signed-in user. The
   * server fetches the feed itself (browsers are blocked by CORS), refuses
   * private and loopback addresses, and caches results briefly. Failures
   * answer `502 feed_unavailable`.
   */
  feed: '/api/feed',
  /** PUT `feedReadPutSchema` → 204: marks the feed read for the current user. */
  feedRead: '/api/feed/read'
} as const

export const KEYCLOAK_PROVIDER_ID = 'keycloak'

// ---------------------------------------------------------------------------
// Desktop bridge
// ---------------------------------------------------------------------------

/**
 * Desktop modules: features only the desktop app offers, because they need the
 * operating system (tray, native notifications, the file system, autostart,
 * `jlucampus://` links). Their code lives entirely in the Electron app: the
 * main process implements them, the preload exposes each one as
 * `DesktopBridge.modules[id]`, and the web app draws their UI only when the
 * bridge offers them, so the web app and PWA never show them. A module with a
 * page also has a desktop component (`DESKTOP_COMPONENT_TYPES`), so its page
 * sits in sidebars and presets like any component. See
 * `docs/DESKTOP-MODULES.md`.
 */
export const DESKTOP_MODULE_IDS = ['notifications', 'files', 'system'] as const
export type DesktopModuleId = (typeof DESKTOP_MODULE_IDS)[number]

/** The scheme of links that open the desktop app on a page: `jlucampus://c/<id>`. */
export const DESKTOP_LINK_SCHEME = 'jlucampus'

/**
 * The in-app path a desktop link points at (`jlucampus://c/abc` → `/c/abc`),
 * or `null` if the value is no such link or leaves the app.
 */
export function desktopLinkPath(value: string): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== `${DESKTOP_LINK_SCHEME}:`) return null
  // `jlucampus://c/abc`: the first segment parses as the host.
  const path = `/${url.host}${url.pathname}`.replace(/\/+$/, '') || '/'
  return isAppPath(path) ? `${path}${url.search}` : null
}

/** The desktop link for an in-app path (`/c/abc` → `jlucampus://c/abc`). */
export function desktopLinkFor(path: string): string {
  return `${DESKTOP_LINK_SCHEME}://${path.replace(/^\/+/, '')}`
}

/** Whether `path` is a path inside the app: absolute, not protocol-relative, no dot segments. */
export function isAppPath(path: string): boolean {
  return (
    path.startsWith('/') &&
    !path.startsWith('//') &&
    !path.includes('\\') &&
    !path.split('/').some((segment) => segment === '..' || segment === '.')
  )
}

/** Tray and native notifications ("Benachrichtigungen & Tray"). */
export interface DesktopNotificationSettings {
  /** Native notifications for new feed entries. */
  enabled: boolean
  /** Closing the window keeps the app running in the tray. */
  closeToTray: boolean
}

export interface DesktopNotification {
  title: string
  body: string
  /** In-app path opened when the notification is clicked, e.g. `/c/<id>`. */
  path: string
}

export interface DesktopNotificationsBridge {
  getSettings: () => Promise<DesktopNotificationSettings>
  setSettings: (patch: Partial<DesktopNotificationSettings>) => Promise<DesktopNotificationSettings>
  /** Shows a native notification unless notifications are off. */
  show: (notification: DesktopNotification) => Promise<void>
  /** Number of feeds with unread entries: tray tooltip and app badge (macOS, Linux launchers). */
  setUnreadCount: (count: number) => Promise<void>
}

/**
 * A place in the files module. The renderer never handles paths itself: it
 * gets ids, and the main process opens what an id stands for.
 */
export interface DesktopPlace {
  id: string
  /** Standard folders come from the OS; `folder` and `network` were added by the user. */
  kind: 'downloads' | 'documents' | 'desktop' | 'folder' | 'network'
  /** Display name; standard folders have none and are named by the web app. */
  name: string | null
  /** Where it points, for display: a local path, `\\server\share` or `smb://server/share`. */
  location: string
  /** Local: the folder exists. Network: the server answered on port 445. */
  available: boolean
}

export interface DesktopRecentFile {
  id: string
  name: string
  size: number
  modifiedAt: string
  /**
   * `false` for programs, installers and scripts, which the app never runs; they can still be
   * shown in their folder.
   */
  openable: boolean
}

export interface DesktopFilesBridge {
  places: () => Promise<DesktopPlace[]>
  /** The newest files in the Downloads folder, newest first. */
  recentDownloads: () => Promise<DesktopRecentFile[]>
  /** Opens the native folder picker; `null` when the user cancels. */
  pickFolder: () => Promise<DesktopPlace | null>
  /** Adds a folder dropped onto the page; rejects files that are not folders. */
  addDropped: (file: File) => Promise<DesktopPlace>
  /** Adds a network share given as `\\server\share` or `smb://server/share`. */
  addNetwork: (address: string, name: string) => Promise<DesktopPlace>
  /** Removes a place the user added; standard folders stay. */
  remove: (id: string) => Promise<void>
  /** Opens a place in the system file manager. */
  open: (id: string) => Promise<void>
  /** Opens a recent download with its default app. */
  openFile: (id: string) => Promise<void>
  /** Shows a recent download in its folder. */
  showFile: (id: string) => Promise<void>
}

/** Autostart and `jlucampus://` links. */
export interface DesktopSystemSettings {
  /** The app starts when the user signs in to the computer. */
  autostart: boolean
  /** Whether the OS allows changing autostart for this build (not for development builds). */
  autostartSupported: boolean
  /** This app is the handler of `jlucampus://` links. */
  linkHandler: boolean
}

export interface DesktopSystemBridge {
  getSettings: () => Promise<DesktopSystemSettings>
  setAutostart: (enabled: boolean) => Promise<DesktopSystemSettings>
  /** Copies `jlucampus://…` for an in-app path to the clipboard. */
  copyLink: (path: string) => Promise<string>
}

export interface DesktopModuleBridges {
  notifications: DesktopNotificationsBridge
  files: DesktopFilesBridge
  system: DesktopSystemBridge
}

/**
 * What the Electron preload exposes as `window.justCampus`. The web app reads
 * it to find the API and to open external links through the OS browser; in
 * a plain browser the property is absent.
 */
export interface DesktopBridge {
  platform: 'electron'
  /** The operating system, for texts that differ ("Explorer", "Finder", "Dateimanager"). */
  os: 'windows' | 'macos' | 'linux'
  /** API origin, e.g. `https://campus.example.org`. */
  apiUrl: string
  /** Opens a URL in the system browser. */
  openExternal: (url: string) => Promise<void>
  /** The desktop modules this build offers; an absent key means the module is not there. */
  modules: Partial<DesktopModuleBridges>
  /**
   * Called when the app is asked to show an in-app path: a `jlucampus://` link,
   * a notification or the tray menu. Returns the unsubscribe function.
   */
  onNavigate: (listener: (path: string) => void) => () => void
  /** Tells the main process the interface language, for the tray menu and notifications. */
  setLanguage: (language: Language) => void
}

declare global {
  interface Window {
    justCampus?: DesktopBridge
  }
}
