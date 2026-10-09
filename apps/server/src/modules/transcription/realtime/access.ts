import { eq } from 'drizzle-orm'

import { loadAccess } from '../../../access.js'
import { ApiError } from '../../../api.js'
import { db } from '../../../db/index.js'
import { component } from '../../../db/schema.js'

/** Re-read roles and component availability for an open socket, without the request cache. */
export async function hasLiveAccess(userId: string, componentId: string): Promise<boolean> {
  try {
    const access = await loadAccess(userId)
    if (!access.componentIds.has(componentId) || !access.features.has('transcription.live')) {
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
