import { jobOfKey, objectKeys, type TranscriptionStorage } from '../storage.js'
import { jobsKeepingObjects } from './store.js'

/**
 * The orphan sweep (T-08): storage itself is the list of what to delete, not the jobs table. A
 * signed upload stays usable until its URL expires, and S3 checks that only when the `PUT` starts,
 * so a slow transfer may store audio long after its job was deleted and its row purged. No time
 * limit on the jobs table can rule that out; listing the objects can. Each sweep reads one page of
 * keys below `objectKeys.root`, from where the last one stopped, and deletes every job object whose
 * job is gone, deleted or expired. Only objects older than `ORPHAN_MIN_AGE_MS` go, so clocks that
 * differ between storage and server cannot remove what a job just stored.
 */

export const ORPHAN_MIN_AGE_MS = 15 * 60_000
/** Keys per sweep: one S3 listing page, so a sweep stays one listing, one query, one deletion. */
export const ORPHAN_PAGE_SIZE = 1000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface OrphanSweep {
  /** Where the next sweep goes on; `null` starts again from the first key. */
  cursor: string | null
  /** Objects deleted. */
  deleted: number
}

/**
 * Deletes the orphaned job objects of one listing page after `cursor`. Keys outside a job's
 * prefix (e.g. the admin's connection test) and objects of unknown age stay. Objects the storage
 * refused to delete are logged and found again on the next pass.
 */
export async function sweepOrphanObjects(
  storage: TranscriptionStorage,
  cursor: string | null,
  now = new Date(),
  pageSize = ORPHAN_PAGE_SIZE
): Promise<OrphanSweep> {
  const page = await storage.listObjects(objectKeys.root, {
    startAfter: cursor ?? undefined,
    maxKeys: pageSize
  })
  const settledBefore = now.getTime() - ORPHAN_MIN_AGE_MS
  const candidates = page.objects.flatMap((object) => {
    const owner = jobOfKey(object.key)
    if (!owner || !UUID.test(owner.jobId)) return []
    if (!object.lastModified || object.lastModified.getTime() > settledBefore) return []
    return [{ key: object.key, componentId: owner.componentId, id: owner.jobId.toLowerCase() }]
  })
  const ids = [...new Set(candidates.map((candidate) => candidate.id))]
  const kept = new Set(
    (await jobsKeepingObjects(ids, now)).map((row) => `${row.componentId}/${row.id.toLowerCase()}`)
  )
  const orphans = candidates
    .filter((candidate) => !kept.has(`${candidate.componentId}/${candidate.id}`))
    .map((candidate) => candidate.key)
  const failures = await storage.deleteObjects(orphans)
  if (failures.length > 0) {
    console.error('Removing orphaned transcription objects failed', failures)
  }
  const last = page.objects.at(-1)?.key
  return { cursor: page.truncated && last ? last : null, deleted: orphans.length - failures.length }
}
