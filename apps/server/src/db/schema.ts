import type {
  ComponentConfig,
  Dashboard,
  Sidebar,
  TranslatorGlossaryEntry
} from '@justcampus/shared'
import { sql } from 'drizzle-orm'
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from 'drizzle-orm/pg-core'

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  role: text('role').notNull().default('user'),
  language: text('language'),
  keycloakRoles: text('keycloak_roles')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  keycloakGroups: text('keycloak_groups')
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  layoutInitializedAt: timestamp('layout_initialized_at'),
  lastSignInAt: timestamp('last_sign_in_at')
})

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at').notNull(),
    token: text('token').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' })
  },
  (table) => [
    uniqueIndex('session_token_uidx').on(table.token),
    index('session_user_id_idx').on(table.userId)
  ]
)

export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at'),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow()
  },
  (table) => [index('account_user_id_idx').on(table.userId)]
)

export const verification = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow()
  },
  (table) => [index('verification_identifier_idx').on(table.identifier)]
)

export const component = pgTable(
  'component',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    type: text('type').notNull(),
    icon: text('icon'),
    iconUrl: text('icon_url'),
    config: jsonb('config').$type<ComponentConfig>().notNull(),
    enabled: boolean('enabled').notNull().default(true),
    singleton: boolean('singleton').notNull().default(false),
    secrets: jsonb('secrets').$type<Record<string, string>>().notNull().default({}),
    sortOrder: integer('sort_order').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow()
  },
  (table) => [
    index('component_enabled_sort_order_idx').on(table.enabled, table.sortOrder),
    uniqueIndex('component_singleton_type_uidx')
      .on(table.type)
      .where(sql`${table.singleton} = true`)
  ]
)

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea'
})

export const translatorDocument = pgTable(
  'translator_document',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    componentId: uuid('component_id')
      .notNull()
      .references(() => component.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    size: integer('size').notNull(),
    source: text('source'),
    target: text('target').notNull(),
    formality: text('formality').notNull(),
    status: text('status').notNull().default('queued'),
    secondsRemaining: integer('seconds_remaining'),
    error: text('error'),
    deeplDocumentId: text('deepl_document_id').notNull(),
    deeplDocumentKey: text('deepl_document_key').notNull(),
    result: bytea('result'),
    resultContentType: text('result_content_type'),
    deletedAt: timestamp('deleted_at'),
    pollClaimedAt: timestamp('poll_claimed_at'),
    polledAt: timestamp('polled_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    expiresAt: timestamp('expires_at').notNull()
  },
  (table) => [
    index('translator_document_user_created_idx').on(table.userId, table.createdAt),
    index('translator_document_status_expires_idx').on(table.status, table.expiresAt),
    index('translator_document_expires_idx').on(table.expiresAt)
  ]
)

/**
 * A translator glossary: its owner's term pairs (`TranslatorGlossaryEntry[]`), private to them,
 * shared with the users of one role (`organization`, `visible_to`) or public for every user of the
 * translator. The users of `editor_role` edit it too. Roles are `TranslatorGlossaryRole`s.
 */
export const translatorGlossary = pgTable(
  'translator_glossary',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    componentId: uuid('component_id')
      .notNull()
      .references(() => component.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    category: text('category').notNull().default('general'),
    visibility: text('visibility').notNull().default('private'),
    visibleTo: text('visible_to'),
    editorRole: text('editor_role'),
    entries: jsonb('entries').$type<TranslatorGlossaryEntry[]>().notNull().default([]),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow()
  },
  (table) => [
    index('translator_glossary_user_idx').on(table.userId),
    index('translator_glossary_component_visibility_idx').on(table.componentId, table.visibility)
  ]
)

export const folderTemplate = pgTable(
  'folder_template',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    icon: text('icon'),
    enabled: boolean('enabled').notNull().default(true),
    sortOrder: integer('sort_order').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow()
  },
  (table) => [index('folder_template_enabled_sort_order_idx').on(table.enabled, table.sortOrder)]
)

export const folderTemplateItem = pgTable(
  'folder_template_item',
  {
    templateId: uuid('template_id')
      .notNull()
      .references(() => folderTemplate.id, { onDelete: 'cascade' }),
    componentId: uuid('component_id')
      .notNull()
      .references(() => component.id, { onDelete: 'cascade' }),
    widgetKey: text('widget_key').notNull(),
    position: integer('position').notNull()
  },
  (table) => [
    primaryKey({ columns: [table.templateId, table.componentId, table.widgetKey] }),
    index('folder_template_item_component_id_idx').on(table.componentId)
  ]
)

export const layoutPreset = pgTable(
  'layout_preset',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** 'role', 'group', or 'everyone'. */
    audienceKind: text('audience_kind').notNull(),
    audienceName: text('audience_name'),
    sortOrder: integer('sort_order').notNull(),
    sidebar: jsonb('sidebar').$type<Sidebar>().notNull(),
    dashboard: jsonb('dashboard').$type<Dashboard>().notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow()
  },
  (table) => [
    index('layout_preset_sort_order_idx').on(table.sortOrder),
    uniqueIndex('layout_preset_everyone_uidx')
      .on(table.audienceKind)
      .where(sql`${table.audienceKind} = 'everyone'`)
  ]
)

export const sidebarEntry = pgTable(
  'sidebar_entry',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    componentId: uuid('component_id')
      .notNull()
      .references(() => component.id, { onDelete: 'cascade' }),
    position: integer('position').notNull()
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.componentId] }),
    index('sidebar_entry_user_position_idx').on(table.userId, table.position),
    index('sidebar_entry_component_id_idx').on(table.componentId)
  ]
)

export const feedRead = pgTable(
  'feed_read',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    feedUrl: text('feed_url').notNull(),
    readAt: timestamp('read_at').notNull()
  },
  (table) => [primaryKey({ columns: [table.userId, table.feedUrl] })]
)

export const dashboardTile = pgTable(
  'dashboard_tile',
  {
    id: uuid('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** 'widget', 'folder', 'link', or 'feed'. */
    kind: text('kind').notNull().default('widget'),
    componentId: uuid('component_id').references(() => component.id, { onDelete: 'cascade' }),
    widgetKey: text('widget_key'),
    title: text('title'),
    url: text('url'),
    icon: text('icon'),
    x: integer('x').notNull(),
    y: integer('y').notNull(),
    w: integer('w').notNull(),
    h: integer('h').notNull()
  },
  (table) => [
    index('dashboard_tile_user_id_idx').on(table.userId),
    index('dashboard_tile_component_id_idx').on(table.componentId)
  ]
)

export const dashboardFolderItem = pgTable(
  'dashboard_folder_item',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tileId: uuid('tile_id')
      .notNull()
      .references(() => dashboardTile.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().default('widget'),
    componentId: uuid('component_id').references(() => component.id, { onDelete: 'cascade' }),
    widgetKey: text('widget_key'),
    title: text('title'),
    url: text('url'),
    icon: text('icon'),
    position: integer('position').notNull()
  },
  (table) => [
    uniqueIndex('dashboard_folder_item_tile_id_component_id_widget_key_uidx').on(
      table.tileId,
      table.componentId,
      table.widgetKey
    ),
    index('dashboard_folder_item_component_id_idx').on(table.componentId)
  ]
)
