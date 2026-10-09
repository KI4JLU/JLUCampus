import type {
  AnnouncementKind,
  AnnouncementTarget,
  AnnouncementTexts,
  BuiltInRole,
  FeatureKey,
  ComponentConfig,
  ComponentNameTranslations,
  Dashboard,
  Sidebar,
  TranscriptionJobError,
  TranscriptionJobSettings,
  TranscriptionProgress,
  TranscriptionResult,
  TranscriptionSegment,
  TranscriptionSnippet,
  TranscriptionSourceFile,
  TranscriptionSpeaker,
  TranscriptionSpeakerColorId,
  TranscriptionSpeakerColorMap,
  TranscriptionTemplateBlock,
  TranscriptionWord,
  TranslatorGlossaryEntry
} from '@justcampus/shared'
import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  customType,
  doublePrecision,
  foreignKey,
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
  language: text('language'),
  /** Keycloak's `preferred_username`, `given_name` and `family_name`, refreshed on every sign-in. */
  username: text('username'),
  givenName: text('given_name'),
  familyName: text('family_name'),
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
      .references(() => user.id, { onDelete: 'cascade' }),
    // The Keycloak session this session was signed in with (`keycloak-session.ts`). Not a
    // Better-Auth field, so it never reaches the client.
    keycloakRefreshToken: text('keycloak_refresh_token'),
    keycloakCheckedAt: timestamp('keycloak_checked_at')
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
    nameTranslations: jsonb('name_translations')
      .$type<ComponentNameTranslations>()
      .notNull()
      .default({}),
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

export const appRole = pgTable('app_role', {
  id: uuid('id').primaryKey().defaultRandom(),
  builtIn: text('built_in').$type<BuiltInRole>().unique(),
  name: text('name').notNull(),
  keycloakRoles: jsonb('keycloak_roles').$type<string[]>().notNull().default([]),
  keycloakGroups: jsonb('keycloak_groups').$type<string[]>().notNull().default([]),
  features: jsonb('features').$type<FeatureKey[]>().notNull().default([]),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow()
})

export const appRoleComponent = pgTable(
  'app_role_component',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => appRole.id, { onDelete: 'cascade' }),
    componentId: uuid('component_id')
      .notNull()
      .references(() => component.id, { onDelete: 'cascade' })
  },
  (table) => [
    primaryKey({ columns: [table.roleId, table.componentId] }),
    index('app_role_component_component_id_idx').on(table.componentId)
  ]
)

export const appRoleMember = pgTable(
  'app_role_member',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => appRole.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').notNull().defaultNow()
  },
  (table) => [
    primaryKey({ columns: [table.roleId, table.userId] }),
    index('app_role_member_user_id_idx').on(table.userId)
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

/**
 * One uploaded file of the transcription module and its way through the pipeline
 * (`TranscriptionJobStatus`). The audio lives in object storage under `object_key`; the worker
 * claims a job with `claimed_at` and renews `heartbeat_at` while it works, so a crashed process's
 * jobs are taken up again. Unsaved jobs expire (`expires_at`). Saving one into a transcript sets
 * `transcript_id` and clears `expires_at`, so its audio stays for playback as long as the
 * transcript; when the transcript goes, the job loses the reference and expires like an unsaved one.
 */
export const transcriptionJob = pgTable(
  'transcription_job',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    componentId: uuid('component_id')
      .notNull()
      .references(() => component.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** The upload group (one transcript) and the file's place in it. */
    groupId: uuid('group_id'),
    groupOrder: integer('group_order').notNull().default(0),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull().default(''),
    size: bigint('size', { mode: 'number' }).notNull(),
    duration: doublePrecision('duration'),
    /** Object keys of the original upload and of the normalised audio. */
    objectKey: text('object_key').notNull(),
    normalizedKey: text('normalized_key'),
    status: text('status').notNull().default('uploading'),
    settings: jsonb('settings').$type<TranscriptionJobSettings>().notNull(),
    speakers: jsonb('speakers').$type<TranscriptionSpeaker[]>().notNull().default([]),
    mapping: jsonb('mapping').$type<Record<string, string>>().notNull().default({}),
    snippets: jsonb('snippets').$type<TranscriptionSnippet[]>().notNull().default([]),
    colors: jsonb('colors')
      .$type<Record<string, TranscriptionSpeakerColorId>>()
      .notNull()
      .default({}),
    progress: jsonb('progress').$type<TranscriptionProgress>(),
    result: jsonb('result').$type<TranscriptionResult>(),
    error: jsonb('error').$type<TranscriptionJobError>(),
    /** An id the diarisation or another upstream gave the work, if any. */
    upstreamJobId: text('upstream_job_id'),
    transcriptId: uuid('transcript_id').references(() => transcriptionTranscript.id, {
      onDelete: 'set null'
    }),
    attempts: integer('attempts').notNull().default(0),
    claimedAt: timestamp('claimed_at'),
    heartbeatAt: timestamp('heartbeat_at'),
    cancelRequestedAt: timestamp('cancel_requested_at'),
    uploadedAt: timestamp('uploaded_at'),
    completedAt: timestamp('completed_at'),
    deletedAt: timestamp('deleted_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    expiresAt: timestamp('expires_at')
  },
  (table) => [
    index('transcription_job_user_created_idx').on(table.userId, table.createdAt),
    index('transcription_job_status_claimed_idx').on(table.status, table.claimedAt),
    index('transcription_job_expires_idx').on(table.expiresAt),
    index('transcription_job_transcript_idx').on(table.transcriptId)
  ]
)

/**
 * A saved transcript (history entry). `revision` grows with every change, and a `PATCH` naming
 * another revision is refused, so overlapping edits are not lost. `idempotency_key` makes saving a
 * group's result safe to repeat. `expires_at` is set only under an admin retention period.
 */
export const transcriptionTranscript = pgTable(
  'transcription_transcript',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    componentId: uuid('component_id')
      .notNull()
      .references(() => component.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    idempotencyKey: uuid('idempotency_key').notNull(),
    title: text('title').notNull(),
    subtitle: text('subtitle'),
    /** 'ai' or 'manual'. */
    subtitleSource: text('subtitle_source'),
    language: text('language'),
    duration: doublePrecision('duration'),
    model: text('model'),
    provider: text('provider'),
    originalFilename: text('original_filename'),
    fileSize: bigint('file_size', { mode: 'number' }),
    segments: jsonb('segments').$type<TranscriptionSegment[]>().notNull().default([]),
    words: jsonb('words').$type<TranscriptionWord[]>().notNull().default([]),
    text: text('text').notNull().default(''),
    sourceFiles: jsonb('source_files').$type<TranscriptionSourceFile[]>().notNull().default([]),
    speakerColors: jsonb('speaker_colors')
      .$type<TranscriptionSpeakerColorMap>()
      .notNull()
      .default({}),
    summaryTemplateId: text('summary_template_id'),
    revision: integer('revision').notNull().default(1),
    userLocale: text('user_locale'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    expiresAt: timestamp('expires_at')
  },
  (table) => [
    index('transcription_transcript_user_updated_idx').on(table.userId, table.updatedAt),
    index('transcription_transcript_expires_idx').on(table.expiresAt),
    uniqueIndex('transcription_transcript_user_idempotency_uidx').on(
      table.userId,
      table.idempotencyKey
    )
  ]
)

/**
 * A user's summary template. The five built-ins live in code
 * (`TRANSCRIPTION_BUILTIN_TEMPLATES`); a row without `user_id` would be an admin-wide one, which
 * users cannot change either. `id` is text so built-in slugs and UUIDs share one id space.
 */
export const transcriptionTemplate = pgTable(
  'transcription_template',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    componentId: uuid('component_id')
      .notNull()
      .references(() => component.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    structure: jsonb('structure').$type<TranscriptionTemplateBlock[]>().notNull(),
    version: integer('version').notNull().default(1),
    outputFormatHints: text('output_format_hints'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow()
  },
  (table) => [
    index('transcription_template_component_user_idx').on(table.componentId, table.userId)
  ]
)

/** A user's own transcript export format (`TranscriptFormatFlags` plus a name). */
export const transcriptionFormat = pgTable(
  'transcription_format',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    componentId: uuid('component_id')
      .notNull()
      .references(() => component.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    speakers: boolean('speakers').notNull(),
    timestamps: boolean('timestamps').notNull(),
    avatars: boolean('avatars').notNull(),
    bubbles: boolean('bubbles').notNull(),
    anonymize: boolean('anonymize').notNull(),
    /** 'chronological' or 'speaker'. */
    order: text('order').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow()
  },
  (table) => [index('transcription_format_user_idx').on(table.userId)]
)

/**
 * A generated summary or set of preview sections, cached per transcript revision, template
 * version, model and settings (`settings_hash`). An edit raises the revision, so the cache goes
 * stale without being touched; deleting the transcript removes it.
 */
export const transcriptionSummary = pgTable(
  'transcription_summary',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    componentId: uuid('component_id')
      .notNull()
      .references(() => component.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    transcriptId: uuid('transcript_id').notNull(),
    /** 'summary' or 'preview'. */
    kind: text('kind').notNull().default('summary'),
    templateId: text('template_id').notNull(),
    templateVersion: integer('template_version').notNull(),
    transcriptRevision: integer('transcript_revision').notNull(),
    model: text('model'),
    settingsHash: text('settings_hash').notNull(),
    markdown: text('markdown'),
    /** Preview results keyed by section id. */
    sections: jsonb('sections').$type<Record<string, string>>(),
    generatedAt: timestamp('generated_at').notNull().defaultNow(),
    expiresAt: timestamp('expires_at')
  },
  (table) => [
    // Named here: the generated name would pass Postgres's 63 characters.
    foreignKey({
      name: 'transcription_summary_transcript_fk',
      columns: [table.transcriptId],
      foreignColumns: [transcriptionTranscript.id]
    }).onDelete('cascade'),
    index('transcription_summary_transcript_template_idx').on(
      table.transcriptId,
      table.templateId,
      table.kind
    ),
    index('transcription_summary_expires_idx').on(table.expiresAt)
  ]
)

export const announcement = pgTable('announcement', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind').$type<AnnouncementKind>().notNull(),
  texts: jsonb('texts').$type<AnnouncementTexts>().notNull(),
  target: jsonb('target').$type<AnnouncementTarget>(),
  enabled: boolean('enabled').notNull().default(true),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow()
})

export const announcementSeen = pgTable(
  'announcement_seen',
  {
    announcementId: uuid('announcement_id')
      .notNull()
      .references(() => announcement.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    seenAt: timestamp('seen_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [primaryKey({ columns: [table.announcementId, table.userId] })]
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
