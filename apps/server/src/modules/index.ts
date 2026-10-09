import { API, componentTypeSchema, isSingletonType } from '@justcampus/shared'
import { desc } from 'drizzle-orm'
import type { Hono, MiddlewareHandler } from 'hono'
import type { ZodType } from 'zod'

import { getAccess, grantEveryoneComponent } from '../access.js'
import { ApiError } from '../api.js'
import { db } from '../db/index.js'
import { component } from '../db/schema.js'
import { desktopComponentDefaults, moduleRegistry } from './registry.js'
import { loadModuleRuntime } from './runtime.js'
import type { AnyModuleRuntime, AppEnvironment, ModuleConfigMap } from './types.js'

/** Loads a module's component row with its config and decrypted secrets. */
function moduleMiddleware(enabledOnly: boolean): MiddlewareHandler<AppEnvironment> {
  return async (context, next) => {
    const parsedType = componentTypeSchema.safeParse(context.req.param('type'))
    if (!parsedType.success || !isSingletonType(parsedType.data)) {
      throw new ApiError(404, 'not_found', 'Module not found')
    }
    const type = parsedType.data

    const serverModule = moduleRegistry[type]
    const runtime = await loadModuleRuntime(
      type,
      serverModule.configSchema as ZodType<ModuleConfigMap[typeof type]>,
      enabledOnly
    )
    if (!runtime) throw new ApiError(404, 'not_found', 'Module not found')
    if (enabledOnly && !(await getAccess(context)).componentIds.has(runtime.componentId)) {
      throw new ApiError(403, 'forbidden', 'Component permission required')
    }
    context.set('module', runtime as AnyModuleRuntime)
    await next()
  }
}

/** Registers each module's endpoints and admin endpoints; the admin check must come first. */
export function registerModuleRoutes(app: Hono<AppEnvironment>): void {
  app.use('/api/modules/:type/*', moduleMiddleware(true))
  app.use('/api/admin/modules/:type/*', moduleMiddleware(false))
  for (const serverModule of Object.values(moduleRegistry)) {
    app.route(API.module(serverModule.type), serverModule.app)
    if (serverModule.adminApp) app.route(API.adminModule(serverModule.type), serverModule.adminApp)
  }
}

/**
 * Inserts every missing built-in component at the end of the catalogue: modules disabled, since
 * they need configuring first, desktop components enabled, since they have nothing to configure.
 */
export async function ensureSingletonComponents(): Promise<void> {
  const builtIns = [
    ...Object.values(moduleRegistry).map((serverModule) => ({
      type: serverModule.type,
      name: serverModule.defaultName,
      nameTranslations: serverModule.defaultNameTranslations,
      icon: serverModule.defaultIcon,
      config: serverModule.defaultConfig,
      enabled: false
    })),
    ...Object.entries(desktopComponentDefaults).map(([type, defaults]) => ({
      type,
      ...defaults,
      config: {},
      enabled: true
    }))
  ]
  for (const builtIn of builtIns) {
    const [last] = await db
      .select({ sortOrder: component.sortOrder })
      .from(component)
      .orderBy(desc(component.sortOrder))
      .limit(1)
    await db.transaction(async (transaction) => {
      const [created] = await transaction
        .insert(component)
        .values({
          ...builtIn,
          iconUrl: null,
          singleton: true,
          secrets: {},
          sortOrder: (last?.sortOrder ?? -1) + 1
        })
        .onConflictDoNothing()
        .returning({ id: component.id })
      if (created) await grantEveryoneComponent(created.id, transaction)
    })
  }
}

export function startModules(): () => void {
  const stops = Object.values(moduleRegistry)
    .map((module) => module.start?.())
    .filter((stop) => stop !== undefined)
  return () => {
    for (const stop of stops) stop()
  }
}

export type { AppEnvironment, ServerModule } from './types.js'
