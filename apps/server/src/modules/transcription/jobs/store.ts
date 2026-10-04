import {
  TRANSCRIPTION_UPLOAD_URL_TTL_SECONDS,
  type TranscriptionJobStatus
} from '@justcampus/shared'
import {
  and,
  asc,
  count,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
  type SQL
} from 'drizzle-orm'

import { db } from '../../../db/index.js'
import { transcriptionJob } from '../../../db/schema.js'
import type { JobRow } from './rows.js'
import { WORK_STATUSES } from './state.js'

/**
 * The jobs table. Every user-facing query names component and user, so another user's job is as
 * missing as a deleted one. The worker's writes name the claim they hold (`claimed_at`), so a
 * worker whose claim went stale, or whose job was deleted, changes nothing.
 */

export type JobInsert = typeof transcriptionJob.$inferInsert
export type JobChanges = Partial<Omit<JobInsert, 'id' | 'componentId' | 'userId' | 'createdAt'>>

/**
 * Not deleted, and saved or not yet expired. `deleted_at` is never cleared: once the cleanup
 * claimed a job (`claimJobsForCleanup`), no query here finds it again, so nothing can save,
 * analyse or dispatch it while its objects are being deleted.
 */
export function visibleJob(now: Date): SQL {
  return and(
    isNull(transcriptionJob.deletedAt),
    or(
      isNotNull(transcriptionJob.transcriptId),
      isNull(transcriptionJob.expiresAt),
      gt(transcriptionJob.expiresAt, now)
    )
  )!
}

function owned(componentId: string, userId: string): SQL {
  return and(eq(transcriptionJob.componentId, componentId), eq(transcriptionJob.userId, userId))!
}

/** One of the user's jobs, saved ones included (their audio plays in the history, T-24). */
export async function findJob(
  id: string,
  componentId: string,
  userId: string,
  now = new Date()
): Promise<JobRow | undefined> {
  const [row] = await db
    .select()
    .from(transcriptionJob)
    .where(and(eq(transcriptionJob.id, id), owned(componentId, userId), visibleJob(now)))
    .limit(1)
  return row
}

/** One of the user's jobs, also one deleted but not yet purged. */
export async function findJobForDeletion(
  id: string,
  componentId: string,
  userId: string
): Promise<JobRow | undefined> {
  const [row] = await db
    .select()
    .from(transcriptionJob)
    .where(and(eq(transcriptionJob.id, id), owned(componentId, userId)))
    .limit(1)
  return row
}

/** The user's jobs not saved, deleted or expired, in queue order (T-15). */
export async function listJobs(
  componentId: string,
  userId: string,
  now = new Date()
): Promise<JobRow[]> {
  return db
    .select()
    .from(transcriptionJob)
    .where(and(owned(componentId, userId), isNull(transcriptionJob.transcriptId), visibleJob(now)))
    .orderBy(asc(transcriptionJob.createdAt), asc(transcriptionJob.groupOrder))
}

/**
 * The user's jobs uploading, analysing or transcribing. An upload whose signed URL expired can no
 * longer arrive and does not count.
 */
export async function countActiveJobs(
  componentId: string,
  userId: string,
  now = new Date()
): Promise<number> {
  const uploadsSince = new Date(now.getTime() - TRANSCRIPTION_UPLOAD_URL_TTL_SECONDS * 1000)
  const [row] = await db
    .select({ value: count() })
    .from(transcriptionJob)
    .where(
      and(
        owned(componentId, userId),
        or(
          inArray(transcriptionJob.status, [...WORK_STATUSES]),
          and(
            eq(transcriptionJob.status, 'uploading'),
            gt(transcriptionJob.createdAt, uploadsSince)
          )
        ),
        isNull(transcriptionJob.transcriptId),
        visibleJob(now)
      )
    )
  return row?.value ?? 0
}

export async function insertJob(values: JobInsert): Promise<JobRow> {
  const [row] = await db.insert(transcriptionJob).values(values).returning()
  return row!
}

/**
 * Whether the job is unchanged since it was read (`updated_at` as the row had it). Postgres keeps
 * microseconds, a `Date` only milliseconds, so the comparison drops the rest.
 */
export function unchangedSince(updatedAt: Date): SQL {
  return sql`date_trunc('milliseconds', ${transcriptionJob.updatedAt}) = ${updatedAt.toISOString()}::timestamp`
}

/**
 * Moves a job on if it is still in one of `from` (and `where`, if given) and neither deleted nor
 * expired; `undefined` when another request or the cleanup was first. This makes repeated analysis
 * and dispatch safe, and an expiry extension cannot revive a job the cleanup claimed: the
 * conditional `UPDATE` waits for the claim's row lock and then sees `deleted_at` set.
 */
export async function transitionJob(
  id: string,
  from: readonly TranscriptionJobStatus[],
  changes: JobChanges,
  where?: SQL
): Promise<JobRow | undefined> {
  const now = changes.updatedAt ?? new Date()
  const [row] = await db
    .update(transcriptionJob)
    .set({ ...changes, updatedAt: now })
    .where(
      and(
        eq(transcriptionJob.id, id),
        inArray(transcriptionJob.status, [...from]),
        visibleJob(now),
        where
      )
    )
    .returning()
  return row
}

/**
 * Hides a job and asks its worker to stop: a running job becomes `cancelled`. The row stays until
 * its objects are gone (`sweepJobs`).
 */
export async function markDeleted(id: string, now = new Date()): Promise<JobRow | undefined> {
  const [row] = await db
    .update(transcriptionJob)
    .set({
      // Raw SQL binds no `Date`, so the time goes in as the text drizzle writes for timestamps.
      deletedAt: sql`coalesce(${transcriptionJob.deletedAt}, ${now.toISOString()}::timestamp)`,
      cancelRequestedAt: sql`coalesce(${transcriptionJob.cancelRequestedAt}, ${now.toISOString()}::timestamp)`,
      status: sql`case when ${transcriptionJob.status} in ('completed', 'failed') then ${transcriptionJob.status} else 'cancelled' end`,
      updatedAt: now
    })
    .where(eq(transcriptionJob.id, id))
    .returning()
  return row
}

export async function deleteJobRow(id: string): Promise<void> {
  await db.delete(transcriptionJob).where(eq(transcriptionJob.id, id))
}

/** Whether a worker holds a claim on the job that is not stale. */
export function claimHeld(
  row: Pick<JobRow, 'claimedAt' | 'heartbeatAt'>,
  leaseMs: number,
  now = new Date()
): boolean {
  return (
    row.claimedAt !== null &&
    row.heartbeatAt !== null &&
    row.heartbeatAt.getTime() > now.getTime() - leaseMs
  )
}

// ---------------------------------------------------------------------------
// The worker's claims
// ---------------------------------------------------------------------------

/**
 * Claims the next job to work on: queued ones and those whose worker stopped renewing its claim,
 * analyses first (users wait for them in the queue). `SKIP LOCKED` lets several server processes
 * claim at once without taking the same job. A queued analysis becomes `analyzing`.
 */
export async function claimNextJob(
  componentId: string,
  leaseMs: number,
  now = new Date()
): Promise<JobRow | undefined> {
  const candidate = db
    .select({ id: transcriptionJob.id })
    .from(transcriptionJob)
    .where(
      and(
        eq(transcriptionJob.componentId, componentId),
        inArray(transcriptionJob.status, [...WORK_STATUSES]),
        isNull(transcriptionJob.deletedAt),
        isNull(transcriptionJob.cancelRequestedAt),
        or(
          isNull(transcriptionJob.claimedAt),
          isNull(transcriptionJob.heartbeatAt),
          lt(transcriptionJob.heartbeatAt, new Date(now.getTime() - leaseMs))
        )
      )
    )
    .orderBy(
      sql`case when ${transcriptionJob.status} in ('analyzingQueued', 'analyzing') then 0 else 1 end`,
      asc(transcriptionJob.updatedAt)
    )
    .limit(1)
    .for('update', { skipLocked: true })
  const [row] = await db
    .update(transcriptionJob)
    .set({
      claimedAt: now,
      heartbeatAt: now,
      attempts: sql`${transcriptionJob.attempts} + 1`,
      status: sql`case when ${transcriptionJob.status} = 'analyzingQueued' then 'analyzing' else ${transcriptionJob.status} end`,
      updatedAt: now
    })
    .where(inArray(transcriptionJob.id, candidate))
    .returning()
  return row
}

function claimed(id: string, claimedAt: Date): SQL {
  return and(
    eq(transcriptionJob.id, id),
    eq(transcriptionJob.claimedAt, claimedAt),
    isNull(transcriptionJob.deletedAt),
    isNull(transcriptionJob.cancelRequestedAt)
  )!
}

/** Renews a claim; `false` when the job was deleted or another worker took it over. */
export async function renewClaim(id: string, claimedAt: Date, now = new Date()): Promise<boolean> {
  const rows = await db
    .update(transcriptionJob)
    .set({ heartbeatAt: now })
    .where(claimed(id, claimedAt))
    .returning({ id: transcriptionJob.id })
  return rows.length > 0
}

/** Writes a claimed job's progress or result; `undefined` when the claim is lost. */
export async function updateClaimedJob(
  id: string,
  claimedAt: Date,
  changes: JobChanges
): Promise<JobRow | undefined> {
  const [row] = await db
    .update(transcriptionJob)
    .set({ ...changes, updatedAt: changes.updatedAt ?? new Date() })
    .where(claimed(id, claimedAt))
    .returning()
  return row
}

/**
 * Gives a claim up without an outcome, e.g. when the server stops: the job is picked up again at
 * once, and the interrupted attempt does not count.
 */
export async function releaseClaim(id: string, claimedAt: Date): Promise<void> {
  await db
    .update(transcriptionJob)
    .set({
      claimedAt: null,
      heartbeatAt: null,
      attempts: sql`greatest(${transcriptionJob.attempts} - 1, 0)`
    })
    .where(and(eq(transcriptionJob.id, id), eq(transcriptionJob.claimedAt, claimedAt)))
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Jobs whose objects and row go now (T-08, retention): deleted ones, unsaved ones past their
 * expiry, and ones whose transcript was deleted (`transcript_id` set to null by the foreign key,
 * `expires_at` cleared when saved) once `orphanBefore` passed. Jobs a worker still holds wait.
 */
export function cleanupDue(now: Date, leaseMs: number, orphanBefore: Date): SQL {
  return and(
    or(
      isNotNull(transcriptionJob.deletedAt),
      and(isNull(transcriptionJob.transcriptId), lt(transcriptionJob.expiresAt, now)),
      and(
        isNull(transcriptionJob.transcriptId),
        isNull(transcriptionJob.expiresAt),
        lt(transcriptionJob.updatedAt, orphanBefore)
      )
    ),
    or(
      isNull(transcriptionJob.claimedAt),
      isNull(transcriptionJob.heartbeatAt),
      lt(transcriptionJob.heartbeatAt, new Date(now.getTime() - leaseMs))
    )
  )!
}

/**
 * Claims up to `limit` jobs due for cleanup (`cleanupDue`) before any of their objects go: one
 * conditional `UPDATE` marks them deleted, which no later save, analysis, dispatch or worker write
 * accepts (they all require `deleted_at` null). Rows a save or analysis has locked are skipped, and
 * the condition is checked again on the row as the lock leaves it, so a job saved or given a new
 * expiry meanwhile is not claimed. Only the returned jobs' objects may be deleted.
 * What a signed upload stores after its row went, `sweepOrphanObjects` finds by listing storage.
 */
export async function claimJobsForCleanup(
  now: Date,
  leaseMs: number,
  orphanBefore: Date,
  limit = 50
): Promise<Array<Pick<JobRow, 'id' | 'componentId'>>> {
  const due = cleanupDue(now, leaseMs, orphanBefore)
  const candidate = db
    .select({ id: transcriptionJob.id })
    .from(transcriptionJob)
    .where(due)
    .limit(limit)
    .for('update', { skipLocked: true })
  return db
    .update(transcriptionJob)
    .set({
      deletedAt: sql`coalesce(${transcriptionJob.deletedAt}, ${now.toISOString()}::timestamp)`,
      updatedAt: now
    })
    .where(and(inArray(transcriptionJob.id, candidate), due))
    .returning({ id: transcriptionJob.id, componentId: transcriptionJob.componentId })
}

/**
 * Of the job ids, those that still have a row, in whatever state. The orphan sweep deletes only
 * the objects of the others: a row never comes back once purged, while an existing row (even one
 * expired or deleted) may still be saved, analysed or in cleanup, which `claimJobsForCleanup`
 * decides.
 */
export async function existingJobs(
  ids: readonly string[]
): Promise<Array<Pick<JobRow, 'id' | 'componentId'>>> {
  if (ids.length === 0) return []
  return db
    .select({ id: transcriptionJob.id, componentId: transcriptionJob.componentId })
    .from(transcriptionJob)
    .where(inArray(transcriptionJob.id, [...ids]))
}

/** Asks the worker of an expired job to stop, so the sweep can remove it. */
export async function cancelExpiredClaims(now: Date): Promise<void> {
  await db
    .update(transcriptionJob)
    .set({ cancelRequestedAt: now })
    .where(
      and(
        isNull(transcriptionJob.transcriptId),
        isNull(transcriptionJob.cancelRequestedAt),
        isNotNull(transcriptionJob.claimedAt),
        lt(transcriptionJob.expiresAt, now)
      )
    )
}
