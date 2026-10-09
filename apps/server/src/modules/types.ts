import type {
  Component,
  ComponentNameTranslations,
  SecretKey,
  SingletonComponentType
} from '@justcampus/shared'
import type { Hono } from 'hono'
import type { ZodType } from 'zod'

import type { AuthSession } from '../auth.js'
import type { UserAccess } from '../logic.js'

export type ModuleConfigMap = {
  [T in SingletonComponentType]: Extract<Component, { type: T }>['config']
}

/** Decrypted secrets of each module; `null` when the admin has not set one. */
export type ModuleSecretsMap = {
  [T in SingletonComponentType]: { [K in SecretKey<T>]: string | null }
}

export interface ModuleRuntime<T extends SingletonComponentType> {
  type: T
  componentId: string
  config: ModuleConfigMap[T]
  secrets: ModuleSecretsMap[T]
}

export type AnyModuleRuntime = {
  [T in SingletonComponentType]: ModuleRuntime<T>
}[SingletonComponentType]

export type AppEnvironment = {
  Variables: {
    access?: Promise<UserAccess>
    session: AuthSession
    module: AnyModuleRuntime
  }
}

export interface ServerModule<T extends SingletonComponentType> {
  type: T
  defaultName: string
  /** The default name in the languages it differs in. */
  defaultNameTranslations: ComponentNameTranslations
  defaultIcon: string
  defaultConfig: ModuleConfigMap[T]
  configSchema: ZodType<ModuleConfigMap[T]>
  app: Hono<AppEnvironment>
  /** Endpoints under `API.adminModule(type)`: admins only, also while the module is disabled. */
  adminApp?: Hono<AppEnvironment>
  start?: () => () => void
}
