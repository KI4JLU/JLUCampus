import type { FeatureKey } from '@justcampus/shared'
import { eq } from 'drizzle-orm'

import { loadAccess } from '../../../access.js'
import { ApiError } from '../../../api.js'
import { db } from '../../../db/index.js'
import { component } from '../../../db/schema.js'

/**
 * Re-read roles and component availability for an open stream or socket, without the request
 * cache: whether the user may still use the transcription component (and `feature`, if given).
 */
export async function hasModuleAccess(
  userId: string,
  componentId: string,
  feature?: FeatureKey
): Promise<boolean> {
  try {
    const access = await loadAccess(userId)
    if (!access.componentIds.has(componentId) || (feature && !access.features.has(feature))) {
      return false
    }
    const [record] = await db
      .select({ enabled: component.enabled, type: component.type })
      .from(component)
      .where(eq(component.id, componentId))
      .limit(1)
    return record?.enabled === true && record.type === 'transcription'
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return false
    throw error
  }
}

/** `hasModuleAccess` for live transcription. */
export function hasLiveAccess(userId: string, componentId: string): Promise<boolean> {
  return hasModuleAccess(userId, componentId, 'transcription.live')
}
