import { COMPONENT_SECRETS, type SingletonComponentType } from '@justcampus/shared'
import { and, eq } from 'drizzle-orm'
import type { ZodType } from 'zod'

import { db } from '../db/index.js'
import { component } from '../db/schema.js'
import { env } from '../env.js'
import { decryptSecret } from '../secrets.js'
import type { ModuleConfigMap, ModuleRuntime, ModuleSecretsMap } from './types.js'

/**
 * A module's component row with its parsed config and decrypted secrets, or `null` when there is
 * no such row (or it is disabled and `enabledOnly`). The module middleware loads it per request;
 * workers and sweeps load it outside of one.
 */
export async function loadModuleRuntime<T extends SingletonComponentType>(
  type: T,
  configSchema: ZodType<ModuleConfigMap[T]>,
  enabledOnly: boolean
): Promise<ModuleRuntime<T> | null> {
  const [record] = await db
    .select()
    .from(component)
    .where(
      and(
        eq(component.type, type),
        eq(component.singleton, true),
        enabledOnly ? eq(component.enabled, true) : undefined
      )
    )
    .limit(1)
  if (!record) return null

  const config = configSchema.parse(record.config)
  const secrets = Object.fromEntries(
    COMPONENT_SECRETS[type].map((secretKey) => {
      const encrypted = record.secrets[secretKey]
      return [
        secretKey,
        encrypted ? decryptSecret(encrypted, env.COMPONENT_SECRETS_KEY, record.id, secretKey) : null
      ]
    })
  ) as ModuleSecretsMap[T]
  return { type, componentId: record.id, config, secrets }
}
