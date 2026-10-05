import { serveStatic } from '@hono/node-server/serve-static'
import {
  API,
  COMPONENT_SECRETS,
  COMPONENT_WIDGETS,
  adminComponentSchema,
  componentInputSchema,
  componentOrderSchema,
  componentSchema,
  dashboardPutSchema,
  feedReadPutSchema,
  feedQuerySchema,
  folderTemplateInputSchema,
  folderTemplateOrderSchema,
  folderTemplateSchema,
  layoutPresetInputSchema,
  layoutPresetOrderSchema,
  layoutPresetSchema,
  mePatchSchema,
  meSchema,
  isBuiltInType,
  sidebarPutSchema,
  widgetDefinition,
  widgetRefKey,
  widgetSchema,
  type AdminComponent,
  type Component,
  type ComponentType,
  type Me,
  type FolderTemplate,
  type LayoutPreset,
  type LayoutPresetInput,
  type Widget,
  type WidgetRef
} from '@justcampus/shared'
import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { basename, resolve } from 'node:path'
import { z } from 'zod'

import { ApiError, parseBody, validationIssues } from './api.js'
import { auth, getSession } from './auth.js'
import { applySecretsPatch, componentTypeChangeConflicts } from './component-secrets.js'
import { db } from './db/index.js'
import {
  dashboardFolderItem,
  dashboardTile,
  component,
  feedRead,
  folderTemplate,
  folderTemplateItem,
  layoutPreset,
  sidebarEntry,
  user
} from './db/schema.js'
import { env } from './env.js'
import { createFeedLoader, feedKey, FeedUnavailableError } from './feed.js'
import {
  assembleFolderTemplates,
  assembleTiles,
  filterLayout,
  isCompleteOrder,
  tooSmall,
  widgetRefsFromDashboard
} from './logic.js'
import { registerModuleRoutes, type AppEnvironment } from './modules/index.js'
import { isTrustedRequest, trustedOrigins as originsOf } from './origin.js'
import { encryptSecret } from './secrets.js'

function parseId(value: string, label: string): string {
  const result = z.uuid().safeParse(value)
  if (!result.success) {
    throw new ApiError(400, 'validation', `Invalid ${label} id`, validationIssues(result.error))
  }
  return result.data
}

function parseComponentId(value: string): string {
  return parseId(value, 'component')
}

function toComponent(row: typeof component.$inferSelect): Component {
  return componentSchema.parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  })
}

function toAdminComponent(row: typeof component.$inferSelect): AdminComponent {
  const type = row.type as ComponentType
  return adminComponentSchema.parse({
    ...row,
    secrets: Object.fromEntries(
      COMPONENT_SECRETS[type].map((secretKey) => [secretKey, Boolean(row.secrets[secretKey])])
    ),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  })
}

function toFolderTemplate(
  row: typeof folderTemplate.$inferSelect,
  widgets: WidgetRef[]
): FolderTemplate {
  return folderTemplateSchema.parse({
    ...row,
    widgets,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  })
}

async function readMe(userId: string): Promise<Me> {
  const [record] = await db.select().from(user).where(eq(user.id, userId)).limit(1)
  if (!record) throw new ApiError(404, 'not_found', 'User not found')
  return meSchema.parse(record)
}

async function requireWidgets(refs: readonly WidgetRef[], enabledOnly: boolean): Promise<void> {
  const componentIds = [...new Set(refs.map(({ componentId }) => componentId))]
  if (componentIds.length === 0) return

  const records = await db
    .select({ id: component.id, type: component.type })
    .from(component)
    .where(
      enabledOnly
        ? and(inArray(component.id, componentIds), eq(component.enabled, true))
        : inArray(component.id, componentIds)
    )
  const types = new Map(records.map((record) => [record.id, record.type as ComponentType]))
  const valid = refs.every(({ componentId, widgetKey }) => {
    const type = types.get(componentId)
    return type !== undefined && widgetDefinition(type, widgetKey) !== undefined
  })
  if (!valid) {
    const qualifier = enabledOnly ? ' and belong to an enabled component' : ''
    throw new ApiError(400, 'validation', `Every widget must exist${qualifier}`, [
      {
        path: ['widgets'],
        message: enabledOnly
          ? 'Contains an unknown widget or a widget of a disabled component'
          : 'Contains an unknown widget'
      }
    ])
  }
}

async function requireEnabledComponents(ids: readonly string[]): Promise<void> {
  return requireComponents(ids, true)
}

async function requireComponents(ids: readonly string[], enabledOnly: boolean): Promise<void> {
  const uniqueIds = [...new Set(ids)]
  if (uniqueIds.length === 0) return

  const records = await db
    .select({ id: component.id })
    .from(component)
    .where(
      enabledOnly
        ? and(inArray(component.id, uniqueIds), eq(component.enabled, true))
        : inArray(component.id, uniqueIds)
    )
  if (records.length !== uniqueIds.length) {
    const qualifier = enabledOnly ? ' and be enabled' : ''
    throw new ApiError(400, 'validation', `Every component must exist${qualifier}`, [
      {
        path: ['componentIds'],
        message: enabledOnly
          ? 'Contains an unknown or disabled component id'
          : 'Contains an unknown component id'
      }
    ])
  }
}

/** A tile may not be smaller than its widget's minimum size. */
async function requireMinimumSizes(
  tiles: readonly (WidgetRef & { w: number; h: number })[]
): Promise<void> {
  const ids = [...new Set(tiles.map(({ componentId }) => componentId))]
  if (ids.length === 0) return
  const rows = await db
    .select({ id: component.id, type: component.type })
    .from(component)
    .where(inArray(component.id, ids))
  const types = new Map(rows.map((row) => [row.id, row.type as ComponentType]))
  const issues = tiles.flatMap((tile, index) => {
    const type = types.get(tile.componentId)
    const minimum = type ? widgetDefinition(type, tile.widgetKey) : undefined
    if (minimum === undefined) return []
    return tooSmall(tile, minimum).map((axis) => ({
      path: ['tiles', index, axis],
      message: `Tile must be at least ${minimum.minW}×${minimum.minH} cells`
    }))
  })
  if (issues.length > 0) {
    throw new ApiError(400, 'validation', 'A tile is smaller than its widget allows', issues)
  }
}

function widgetsForComponents(rows: readonly { id: string; type: string }[]): Widget[] {
  return rows.flatMap(({ id, type }) =>
    Object.entries(COMPONENT_WIDGETS[type as ComponentType]).map(([widgetKey, definition]) =>
      widgetSchema.parse({ componentId: id, widgetKey, ...definition })
    )
  )
}

/** Enabled component ids for deletes that must leave disabled component data alone. */
const enabledIdsSubquery = db
  .select({ id: component.id })
  .from(component)
  .where(eq(component.enabled, true))
const loadFeed = createFeedLoader({ allowPrivateHosts: env.FEED_ALLOW_PRIVATE_HOSTS })

export const app = new Hono<AppEnvironment>()

app.use('*', logger())
app.use(
  '/api/*',
  cors({
    origin: env.CORS_ORIGINS,
    credentials: true,
    allowHeaders: ['Content-Type'],
    // The translator's throttle tells the page, as HAWKI's, how many requests are left.
    exposeHeaders: [
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'Retry-After',
      'X-RateLimit-Reset'
    ]
  })
)

/** The web app's origins, and the API's own when it serves the web app itself. */
const trustedOrigins = originsOf(env.CORS_ORIGINS, env.BETTER_AUTH_URL)

// CSRF: CORS does not stop simple cross-site requests from arriving (see `isTrustedRequest`).
app.use('/api/*', async (context, next) => {
  if (!isTrustedRequest(context.req.method, context.req.header('Origin'), trustedOrigins)) {
    return context.json({ error: { code: 'forbidden', message: 'Untrusted origin' } }, 403)
  }
  await next()
})

app.get(API.health, (context) => context.json({ ok: true }))
app.on(['GET', 'POST'], `${API.auth}/*`, (context) => auth.handler(context.req.raw))

app.use('/api/*', async (context, next) => {
  const session = await getSession(context)
  if (!session) {
    return context.json(
      { error: { code: 'unauthorized', message: 'Authentication required' } },
      401
    )
  }
  context.set('session', session)
  await next()
})

app.use('/api/admin/*', async (context, next) => {
  if (context.get('session').user.role !== 'admin') {
    return context.json(
      { error: { code: 'forbidden', message: 'Administrator access required' } },
      403
    )
  }
  await next()
})

registerModuleRoutes(app)

app.get(API.me, async (context) => context.json(await readMe(context.get('session').user.id)))

app.patch(API.me, async (context) => {
  const patch = await parseBody(context, mePatchSchema)
  if (patch.language !== undefined) {
    await db
      .update(user)
      .set({ language: patch.language, updatedAt: new Date() })
      .where(eq(user.id, context.get('session').user.id))
  }
  return context.json(await readMe(context.get('session').user.id))
})

app.get(API.components, async (context) => {
  const rows = await db
    .select()
    .from(component)
    .where(eq(component.enabled, true))
    .orderBy(asc(component.sortOrder))
  return context.json({ components: rows.map(toComponent) })
})

app.get(API.widgets, async (context) => {
  const rows = await db
    .select({ id: component.id, type: component.type })
    .from(component)
    .where(eq(component.enabled, true))
    .orderBy(asc(component.sortOrder))
  return context.json({ widgets: widgetsForComponents(rows) })
})

app.get(API.feed, async (context) => {
  const result = feedQuerySchema.safeParse({ url: context.req.query('url') })
  if (!result.success) {
    throw new ApiError(
      400,
      'validation',
      'Request validation failed',
      validationIssues(result.error)
    )
  }
  try {
    const feed = await loadFeed(result.data.url)
    const [read] = await db
      .select({ readAt: feedRead.readAt })
      .from(feedRead)
      .where(
        and(
          eq(feedRead.userId, context.get('session').user.id),
          eq(feedRead.feedUrl, feedKey(result.data.url))
        )
      )
      .limit(1)
    context.header('Cache-Control', 'private, no-cache')
    return context.json({ ...feed, readAt: read?.readAt.toISOString() ?? null })
  } catch (error) {
    if (error instanceof FeedUnavailableError) {
      throw new ApiError(502, 'feed_unavailable', error.message)
    }
    throw error
  }
})

app.put(API.feedRead, async (context) => {
  const input = await parseBody(context, feedReadPutSchema)
  const readAt = new Date(Math.min(new Date(input.readAt).valueOf(), Date.now()))
  await db
    .insert(feedRead)
    .values({
      userId: context.get('session').user.id,
      feedUrl: feedKey(input.url),
      readAt
    })
    .onConflictDoUpdate({
      target: [feedRead.userId, feedRead.feedUrl],
      set: { readAt: sql`greatest(${feedRead.readAt}, excluded.read_at)` }
    })
  return context.body(null, 204)
})

app.get(API.adminComponents, async (context) => {
  const rows = await db.select().from(component).orderBy(asc(component.sortOrder))
  return context.json({ components: rows.map(toAdminComponent) })
})

app.post(API.adminComponents, async (context) => {
  const input = await parseBody(context, componentInputSchema)
  if (isBuiltInType(input.type)) {
    throw new ApiError(409, 'conflict', 'Modules and desktop components are created by the server')
  }
  const [last] = await db
    .select({ sortOrder: component.sortOrder })
    .from(component)
    .orderBy(desc(component.sortOrder))
    .limit(1)
  const [created] = await db
    .insert(component)
    .values({
      name: input.name,
      type: input.type,
      icon: input.icon,
      iconUrl: input.iconUrl,
      config: input.config,
      enabled: input.enabled,
      sortOrder: (last?.sortOrder ?? -1) + 1
    })
    .returning()
  return context.json(toAdminComponent(created!), 201)
})

// Keep this route before /:id so "order" can never be interpreted as an id.
app.put(API.adminComponentOrder, async (context) => {
  const { ids } = await parseBody(context, componentOrderSchema)
  const existing = await db.select({ id: component.id }).from(component)
  if (
    !isCompleteOrder(
      existing.map(({ id }) => id),
      ids
    )
  ) {
    throw new ApiError(400, 'validation', 'Order must contain every component id exactly once', [
      { path: ['ids'], message: 'Expected every component id exactly once' }
    ])
  }

  await db.transaction(async (transaction) => {
    for (const [sortOrder, id] of ids.entries()) {
      await transaction
        .update(component)
        .set({ sortOrder, updatedAt: new Date() })
        .where(eq(component.id, id))
    }
  })
  return context.body(null, 204)
})

app.get('/api/admin/components/:id', async (context) => {
  const id = parseComponentId(context.req.param('id'))
  const [record] = await db.select().from(component).where(eq(component.id, id)).limit(1)
  if (!record) throw new ApiError(404, 'not_found', 'Component not found')
  return context.json(toAdminComponent(record))
})

app.put('/api/admin/components/:id', async (context) => {
  const id = parseComponentId(context.req.param('id'))
  const input = await parseBody(context, componentInputSchema)
  const secretPatch = 'secrets' in input ? input.secrets : undefined
  const changesSecrets = Object.values(secretPatch ?? {}).some((value) => value !== undefined)

  // The row lock keeps concurrent saves from writing back a stale copy of the secrets.
  const updated = await db.transaction(async (transaction) => {
    const [record] = await transaction
      .select()
      .from(component)
      .where(eq(component.id, id))
      .limit(1)
      .for('update')
    if (!record) throw new ApiError(404, 'not_found', 'Component not found')
    if (componentTypeChangeConflicts(record, input.type)) {
      throw new ApiError(409, 'conflict', 'A component cannot change into or out of a module type')
    }

    const [row] = await transaction
      .update(component)
      .set({
        name: input.name,
        type: input.type,
        icon: input.icon,
        iconUrl: input.iconUrl,
        config: input.config,
        enabled: input.enabled,
        ...(changesSecrets
          ? {
              secrets: applySecretsPatch(record.secrets, secretPatch, (secretKey, value) =>
                encryptSecret(value, env.COMPONENT_SECRETS_KEY, id, secretKey)
              )
            }
          : {}),
        updatedAt: new Date()
      })
      .where(eq(component.id, id))
      .returning()
    return row!
  })
  return context.json(toAdminComponent(updated))
})

app.delete('/api/admin/components/:id', async (context) => {
  const id = parseComponentId(context.req.param('id'))
  const [record] = await db
    .select({ singleton: component.singleton })
    .from(component)
    .where(eq(component.id, id))
    .limit(1)
  if (!record) throw new ApiError(404, 'not_found', 'Component not found')
  if (record.singleton) throw new ApiError(409, 'conflict', 'Modules cannot be deleted')
  const [deleted] = await db
    .delete(component)
    .where(eq(component.id, id))
    .returning({ id: component.id })
  if (!deleted) throw new ApiError(404, 'not_found', 'Component not found')
  return context.body(null, 204)
})

function templateList(
  rows: readonly (typeof folderTemplate.$inferSelect)[],
  items: readonly { templateId: string; componentId: string; widgetKey: string }[],
  enabledWidgetRefs?: ReadonlySet<string>
): FolderTemplate[] {
  return assembleFolderTemplates(
    rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString()
    })),
    items,
    enabledWidgetRefs
  ).map((template) => folderTemplateSchema.parse(template))
}

async function readTemplateItems(
  templateIds: readonly string[]
): Promise<Array<{ templateId: string; componentId: string; widgetKey: string }>> {
  if (templateIds.length === 0) return []
  return db
    .select({
      templateId: folderTemplateItem.templateId,
      componentId: folderTemplateItem.componentId,
      widgetKey: folderTemplateItem.widgetKey
    })
    .from(folderTemplateItem)
    .where(inArray(folderTemplateItem.templateId, templateIds))
    .orderBy(asc(folderTemplateItem.position))
}

app.get(API.folderTemplates, async (context) => {
  const [rows, enabled] = await Promise.all([
    db
      .select()
      .from(folderTemplate)
      .where(eq(folderTemplate.enabled, true))
      .orderBy(asc(folderTemplate.sortOrder)),
    db
      .select({ id: component.id, type: component.type })
      .from(component)
      .where(eq(component.enabled, true))
  ])
  const items = await readTemplateItems(rows.map(({ id }) => id))
  return context.json({
    folders: templateList(rows, items, new Set(widgetsForComponents(enabled).map(widgetRefKey)))
  })
})

app.get(API.adminFolderTemplates, async (context) => {
  const rows = await db.select().from(folderTemplate).orderBy(asc(folderTemplate.sortOrder))
  const items = await readTemplateItems(rows.map(({ id }) => id))
  return context.json({ folders: templateList(rows, items) })
})

app.post(API.adminFolderTemplates, async (context) => {
  const input = await parseBody(context, folderTemplateInputSchema)
  await requireWidgets(input.widgets, false)
  const created = await db.transaction(async (transaction) => {
    const [last] = await transaction
      .select({ sortOrder: folderTemplate.sortOrder })
      .from(folderTemplate)
      .orderBy(desc(folderTemplate.sortOrder))
      .limit(1)
    const [template] = await transaction
      .insert(folderTemplate)
      .values({
        name: input.name,
        icon: input.icon,
        enabled: input.enabled,
        sortOrder: (last?.sortOrder ?? -1) + 1
      })
      .returning()
    if (!template) throw new Error('Folder template insert did not return a row')
    if (input.widgets.length > 0) {
      await transaction.insert(folderTemplateItem).values(
        input.widgets.map(({ componentId, widgetKey }, position) => ({
          templateId: template.id,
          componentId,
          widgetKey,
          position
        }))
      )
    }
    return template
  })
  return context.json(toFolderTemplate(created, input.widgets), 201)
})

// Keep this route before /:id so "order" can never be interpreted as an id.
app.put(API.adminFolderTemplateOrder, async (context) => {
  const { ids } = await parseBody(context, folderTemplateOrderSchema)
  const existing = await db.select({ id: folderTemplate.id }).from(folderTemplate)
  if (
    !isCompleteOrder(
      existing.map(({ id }) => id),
      ids
    )
  ) {
    throw new ApiError(
      400,
      'validation',
      'Order must contain every folder template id exactly once',
      [{ path: ['ids'], message: 'Expected every folder template id exactly once' }]
    )
  }
  await db.transaction(async (transaction) => {
    for (const [sortOrder, id] of ids.entries()) {
      await transaction
        .update(folderTemplate)
        .set({ sortOrder, updatedAt: new Date() })
        .where(eq(folderTemplate.id, id))
    }
  })
  return context.body(null, 204)
})

app.get('/api/admin/folder-templates/:id', async (context) => {
  const id = parseId(context.req.param('id'), 'folder template')
  const [record] = await db.select().from(folderTemplate).where(eq(folderTemplate.id, id)).limit(1)
  if (!record) throw new ApiError(404, 'not_found', 'Folder template not found')
  const items = await readTemplateItems([id])
  return context.json(
    toFolderTemplate(
      record,
      items.map(({ componentId, widgetKey }) => ({ componentId, widgetKey }))
    )
  )
})

app.put('/api/admin/folder-templates/:id', async (context) => {
  const id = parseId(context.req.param('id'), 'folder template')
  const input = await parseBody(context, folderTemplateInputSchema)
  await requireWidgets(input.widgets, false)
  const updated = await db.transaction(async (transaction) => {
    const [template] = await transaction
      .update(folderTemplate)
      .set({ name: input.name, icon: input.icon, enabled: input.enabled, updatedAt: new Date() })
      .where(eq(folderTemplate.id, id))
      .returning()
    if (!template) return null
    await transaction.delete(folderTemplateItem).where(eq(folderTemplateItem.templateId, id))
    if (input.widgets.length > 0) {
      await transaction.insert(folderTemplateItem).values(
        input.widgets.map(({ componentId, widgetKey }, position) => ({
          templateId: id,
          componentId,
          widgetKey,
          position
        }))
      )
    }
    return template
  })
  if (!updated) throw new ApiError(404, 'not_found', 'Folder template not found')
  return context.json(toFolderTemplate(updated, input.widgets))
})

app.delete('/api/admin/folder-templates/:id', async (context) => {
  const id = parseId(context.req.param('id'), 'folder template')
  const [deleted] = await db
    .delete(folderTemplate)
    .where(eq(folderTemplate.id, id))
    .returning({ id: folderTemplate.id })
  if (!deleted) throw new ApiError(404, 'not_found', 'Folder template not found')
  return context.body(null, 204)
})

async function validatePreset(input: LayoutPresetInput): Promise<void> {
  await Promise.all([
    requireComponents(input.sidebar.componentIds, false),
    requireWidgets(widgetRefsFromDashboard(input.dashboard), false)
  ])
  await requireMinimumSizes(input.dashboard.tiles.filter((tile) => tile.kind === 'widget'))
}

async function enabledLayoutReferences(): Promise<{
  componentIds: Set<string>
  widgetRefs: Set<string>
}> {
  const enabled = await db
    .select({ id: component.id, type: component.type })
    .from(component)
    .where(eq(component.enabled, true))
  return {
    componentIds: new Set(enabled.map(({ id }) => id)),
    widgetRefs: new Set(widgetsForComponents(enabled).map(widgetRefKey))
  }
}

function toLayoutPreset(
  row: typeof layoutPreset.$inferSelect,
  enabled: { componentIds: ReadonlySet<string>; widgetRefs: ReadonlySet<string> }
): LayoutPreset {
  const content = filterLayout(row.sidebar, row.dashboard, enabled.componentIds, enabled.widgetRefs)
  return layoutPresetSchema.parse({
    id: row.id,
    name: row.name,
    audience:
      row.audienceKind === 'everyone'
        ? { kind: 'everyone' }
        : { kind: row.audienceKind, name: row.audienceName },
    ...content,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  })
}

function presetValues(input: LayoutPresetInput): {
  name: string
  audienceKind: 'role' | 'group' | 'everyone'
  audienceName: string | null
  sidebar: LayoutPresetInput['sidebar']
  dashboard: LayoutPresetInput['dashboard']
} {
  return {
    name: input.name,
    audienceKind: input.audience.kind,
    audienceName: input.audience.kind === 'everyone' ? null : input.audience.name,
    sidebar: input.sidebar,
    dashboard: input.dashboard
  }
}

function isEveryoneConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  if ('constraint_name' in error && error.constraint_name === 'layout_preset_everyone_uidx') {
    return true
  }
  return 'cause' in error && isEveryoneConflict(error.cause)
}

function everyoneConflict(): ApiError {
  return new ApiError(409, 'conflict', 'An everyone preset already exists')
}

app.get(API.adminPresets, async (context) => {
  const [rows, enabled] = await Promise.all([
    db.select().from(layoutPreset).orderBy(asc(layoutPreset.sortOrder)),
    enabledLayoutReferences()
  ])
  rows.sort((left, right) => {
    const audienceOrder =
      Number(left.audienceKind === 'everyone') - Number(right.audienceKind === 'everyone')
    if (audienceOrder !== 0) return audienceOrder
    return left.sortOrder - right.sortOrder
  })
  return context.json({ presets: rows.map((row) => toLayoutPreset(row, enabled)) })
})

app.post(API.adminPresets, async (context) => {
  const input = await parseBody(context, layoutPresetInputSchema)
  await validatePreset(input)
  try {
    const [last] = await db
      .select({ sortOrder: layoutPreset.sortOrder })
      .from(layoutPreset)
      .orderBy(desc(layoutPreset.sortOrder))
      .limit(1)
    const [created] = await db
      .insert(layoutPreset)
      .values({ ...presetValues(input), sortOrder: (last?.sortOrder ?? -1) + 1 })
      .returning()
    const enabled = await enabledLayoutReferences()
    return context.json(toLayoutPreset(created!, enabled), 201)
  } catch (error) {
    if (isEveryoneConflict(error)) throw everyoneConflict()
    throw error
  }
})

// Keep static routes before /:id so they can never be interpreted as ids.
app.put(API.adminPresetOrder, async (context) => {
  const { ids } = await parseBody(context, layoutPresetOrderSchema)
  const existing = await db.select({ id: layoutPreset.id }).from(layoutPreset)
  if (
    !isCompleteOrder(
      existing.map(({ id }) => id),
      ids
    )
  ) {
    throw new ApiError(400, 'validation', 'Order must contain every preset id exactly once', [
      { path: ['ids'], message: 'Expected every preset id exactly once' }
    ])
  }
  await db.transaction(async (transaction) => {
    for (const [sortOrder, id] of ids.entries()) {
      await transaction
        .update(layoutPreset)
        .set({ sortOrder, updatedAt: new Date() })
        .where(eq(layoutPreset.id, id))
    }
  })
  return context.body(null, 204)
})

app.get(API.adminPresetAudiences, async (context) => {
  const rows = await db
    .select({ roles: user.keycloakRoles, groups: user.keycloakGroups })
    .from(user)
  return context.json({
    roles: [...new Set(rows.flatMap(({ roles }) => roles))].sort(),
    groups: [...new Set(rows.flatMap(({ groups }) => groups))].sort()
  })
})

app.get('/api/admin/presets/:id', async (context) => {
  const id = parseId(context.req.param('id'), 'preset')
  const [records, enabled] = await Promise.all([
    db.select().from(layoutPreset).where(eq(layoutPreset.id, id)).limit(1),
    enabledLayoutReferences()
  ])
  const [record] = records
  if (!record) throw new ApiError(404, 'not_found', 'Preset not found')
  return context.json(toLayoutPreset(record, enabled))
})

app.put('/api/admin/presets/:id', async (context) => {
  const id = parseId(context.req.param('id'), 'preset')
  const input = await parseBody(context, layoutPresetInputSchema)
  await validatePreset(input)
  try {
    const [updated] = await db
      .update(layoutPreset)
      .set({ ...presetValues(input), updatedAt: new Date() })
      .where(eq(layoutPreset.id, id))
      .returning()
    if (!updated) throw new ApiError(404, 'not_found', 'Preset not found')
    const enabled = await enabledLayoutReferences()
    return context.json(toLayoutPreset(updated, enabled))
  } catch (error) {
    if (isEveryoneConflict(error)) throw everyoneConflict()
    throw error
  }
})

app.delete('/api/admin/presets/:id', async (context) => {
  const id = parseId(context.req.param('id'), 'preset')
  const [deleted] = await db
    .delete(layoutPreset)
    .where(eq(layoutPreset.id, id))
    .returning({ id: layoutPreset.id })
  if (!deleted) throw new ApiError(404, 'not_found', 'Preset not found')
  return context.body(null, 204)
})

app.get(API.sidebar, async (context) => {
  const rows = await db
    .select({ componentId: sidebarEntry.componentId })
    .from(sidebarEntry)
    .innerJoin(
      component,
      and(eq(sidebarEntry.componentId, component.id), eq(component.enabled, true))
    )
    .where(eq(sidebarEntry.userId, context.get('session').user.id))
    .orderBy(asc(sidebarEntry.position))
  return context.json({ componentIds: rows.map(({ componentId }) => componentId) })
})

app.put(API.sidebar, async (context) => {
  const { componentIds } = await parseBody(context, sidebarPutSchema)
  await requireEnabledComponents(componentIds)
  const userId = context.get('session').user.id

  // Entries of currently disabled components are invisible to the client and are
  // kept, so re-enabling a component restores its place.
  await db.transaction(async (transaction) => {
    await transaction
      .delete(sidebarEntry)
      .where(
        and(eq(sidebarEntry.userId, userId), inArray(sidebarEntry.componentId, enabledIdsSubquery))
      )
    if (componentIds.length > 0) {
      await transaction
        .insert(sidebarEntry)
        .values(componentIds.map((componentId, position) => ({ userId, componentId, position })))
    }
  })
  return context.json({ componentIds })
})

app.get(API.dashboard, async (context) => {
  const userId = context.get('session').user.id
  const [rows, items, enabled] = await Promise.all([
    db.select().from(dashboardTile).where(eq(dashboardTile.userId, userId)),
    db
      .select({
        id: dashboardFolderItem.id,
        tileId: dashboardFolderItem.tileId,
        kind: dashboardFolderItem.kind,
        componentId: dashboardFolderItem.componentId,
        widgetKey: dashboardFolderItem.widgetKey,
        title: dashboardFolderItem.title,
        url: dashboardFolderItem.url,
        icon: dashboardFolderItem.icon
      })
      .from(dashboardFolderItem)
      .innerJoin(dashboardTile, eq(dashboardFolderItem.tileId, dashboardTile.id))
      .where(eq(dashboardTile.userId, userId))
      .orderBy(asc(dashboardFolderItem.position)),
    db
      .select({ id: component.id, type: component.type })
      .from(component)
      .where(eq(component.enabled, true))
  ])
  const enabledRefs = new Set(widgetsForComponents(enabled).map(widgetRefKey))
  return context.json({ tiles: assembleTiles(rows, items, enabledRefs) })
})

app.put(API.dashboard, async (context) => {
  const { tiles } = await parseBody(context, dashboardPutSchema)
  const widgetTiles = tiles.filter((tile) => tile.kind === 'widget')
  const folders = tiles.filter((tile) => tile.kind === 'folder')
  await requireWidgets(widgetRefsFromDashboard({ tiles }), true)
  await requireMinimumSizes(widgetTiles)
  const userId = context.get('session').user.id

  await db.transaction(async (transaction) => {
    // Folder items of disabled components are invisible to the client; remember them
    // so re-enabling the component puts them back into their folder.
    const hidden = await transaction
      .select({
        id: dashboardFolderItem.id,
        tileId: dashboardFolderItem.tileId,
        kind: dashboardFolderItem.kind,
        componentId: dashboardFolderItem.componentId,
        widgetKey: dashboardFolderItem.widgetKey,
        title: dashboardFolderItem.title,
        url: dashboardFolderItem.url,
        icon: dashboardFolderItem.icon
      })
      .from(dashboardFolderItem)
      .innerJoin(dashboardTile, eq(dashboardFolderItem.tileId, dashboardTile.id))
      .innerJoin(component, eq(dashboardFolderItem.componentId, component.id))
      .where(
        and(
          eq(dashboardTile.userId, userId),
          eq(dashboardFolderItem.kind, 'widget'),
          eq(component.enabled, false)
        )
      )
      .orderBy(asc(dashboardFolderItem.position))

    await transaction
      .delete(dashboardTile)
      .where(
        and(
          eq(dashboardTile.userId, userId),
          or(
            eq(dashboardTile.kind, 'folder'),
            eq(dashboardTile.kind, 'link'),
            eq(dashboardTile.kind, 'feed'),
            inArray(dashboardTile.componentId, enabledIdsSubquery)
          )
        )
      )
    if (tiles.length > 0) {
      await transaction.insert(dashboardTile).values(
        tiles.map((tile) => ({
          id: tile.id,
          userId,
          kind: tile.kind,
          componentId: tile.kind === 'widget' ? tile.componentId : null,
          widgetKey: tile.kind === 'widget' ? tile.widgetKey : null,
          title:
            tile.kind === 'folder' || tile.kind === 'link' || tile.kind === 'feed'
              ? tile.title
              : null,
          url: tile.kind === 'link' ? tile.url : tile.kind === 'feed' ? tile.feedUrl : null,
          icon: tile.kind === 'folder' || tile.kind === 'link' ? (tile.icon ?? null) : null,
          x: tile.x,
          y: tile.y,
          w: tile.w,
          h: tile.h
        }))
      )
    }
    const folderIds = new Set(folders.map(({ id }) => id))
    const rows = [
      ...folders.flatMap((folder) =>
        folder.items.map((item, position) => ({
          id: item.kind === 'link' ? item.id : undefined,
          tileId: folder.id,
          kind: item.kind,
          componentId: item.kind === 'widget' ? item.componentId : null,
          widgetKey: item.kind === 'widget' ? item.widgetKey : null,
          title: item.kind === 'link' ? item.title : null,
          url: item.kind === 'link' ? item.url : null,
          icon: item.kind === 'link' ? item.icon : null,
          position
        }))
      ),
      ...hidden
        .filter((item) => folderIds.has(item.tileId))
        .map((item, index) => ({ ...item, position: 10_000 + index }))
    ]
    if (rows.length > 0) await transaction.insert(dashboardFolderItem).values(rows)
  })
  return context.json({ tiles })
})

if (env.SERVE_WEB_DIR) {
  const webDirectory = resolve(env.SERVE_WEB_DIR)
  const staticFiles = serveStatic<AppEnvironment>({
    root: webDirectory,
    onFound: (path, context) => {
      if (basename(path) === 'index.html') context.header('Cache-Control', 'no-cache')
    }
  })

  app.use('*', (context, next) => {
    if (context.req.path.startsWith('/api/')) return next()
    return staticFiles(context, next)
  })
  app.get('*', async (context, next) => {
    if (context.req.path.startsWith('/api/')) return next()
    context.header('Cache-Control', 'no-cache')
    return serveStatic({ root: webDirectory, path: 'index.html' })(context, next)
  })
}

app.notFound((context) =>
  context.json({ error: { code: 'not_found', message: 'Route not found' } }, 404)
)

app.onError((error, context) => {
  if (error instanceof ApiError) {
    return context.json(
      { error: { code: error.code, message: error.message, issues: error.issues } },
      error.status
    )
  }

  console.error(error)
  return context.json({ error: { code: 'internal', message: 'Internal server error' } }, 500)
})
