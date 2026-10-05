import {
  transcriptionTranscriptSchema,
  transcriptionTranscriptSummarySchema,
  type TranscriptionJobStatus,
  type TranscriptionResult,
  type TranscriptionSegment,
  type TranscriptionSourceFile,
  type TranscriptionSpeakerColorMap,
  type TranscriptionTranscript,
  type TranscriptionTranscriptSummary,
  type TranscriptionWord
} from '@justcampus/shared'
import { and, desc, eq, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm'

import { db } from '../../../db/index.js'
import { transcriptionJob, transcriptionTranscript } from '../../../db/schema.js'
import { visibleJob } from '../jobs/store.js'

/**
 * Saved transcripts (history entries). Every query names the module instance and the user, so
 * another user's transcript is as absent as a missing one. Saving takes the group's jobs out of
 * the active list and keeps their audio for playback; deleting the transcript lets the jobs expire
 * at once, so the job sweep removes their audio.
 */

export type TranscriptRow = typeof transcriptionTranscript.$inferSelect

/** When the admin's retention removes a transcript last changed at `updatedAt`; `null`: never. */
export function retentionExpiry(updatedAt: Date, retentionHours: number | null): Date | null {
  return retentionHours === null ? null : new Date(updatedAt.getTime() + retentionHours * 3_600_000)
}

function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null
}

const summaryColumns = {
  id: transcriptionTranscript.id,
  title: transcriptionTranscript.title,
  subtitle: transcriptionTranscript.subtitle,
  language: transcriptionTranscript.language,
  duration: transcriptionTranscript.duration,
  originalFilename: transcriptionTranscript.originalFilename,
  createdAt: transcriptionTranscript.createdAt,
  updatedAt: transcriptionTranscript.updatedAt
}

type SummaryRow = { [K in keyof typeof summaryColumns]: TranscriptRow[K] }

export function publicTranscriptSummary(
  row: SummaryRow,
  retentionHours: number | null
): TranscriptionTranscriptSummary {
  return transcriptionTranscriptSummarySchema.parse({
    id: row.id,
    title: row.title,
    subtitle: row.subtitle,
    language: row.language,
    duration: row.duration,
    originalFilename: row.originalFilename,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    expiresAt: iso(retentionExpiry(row.updatedAt, retentionHours))
  })
}

export function publicTranscript(
  row: TranscriptRow,
  retentionHours: number | null
): TranscriptionTranscript {
  return transcriptionTranscriptSchema.parse({
    ...publicTranscriptSummary(row, retentionHours),
    subtitleSource:
      row.subtitleSource === 'ai' || row.subtitleSource === 'manual' ? row.subtitleSource : null,
    model: row.model,
    provider: row.provider,
    fileSize: row.fileSize,
    text: row.text,
    segments: row.segments,
    words: row.words,
    sourceFiles: row.sourceFiles,
    speakerColors: row.speakerColors,
    summaryTemplateId: row.summaryTemplateId,
    revision: row.revision
  })
}

/**
 * The module's transcripts of a user. Expiry follows the current retention setting and the last
 * change (`retentionExpiry`); the sweep deletes what is past it.
 */
function ownedBy(componentId: string, userId: string): SQL | undefined {
  return and(
    eq(transcriptionTranscript.componentId, componentId),
    eq(transcriptionTranscript.userId, userId)
  )
}

/** The user's history, newest change first; metadata only. */
export async function listTranscripts(componentId: string, userId: string): Promise<SummaryRow[]> {
  return db
    .select(summaryColumns)
    .from(transcriptionTranscript)
    .where(ownedBy(componentId, userId))
    .orderBy(
      desc(transcriptionTranscript.updatedAt),
      desc(transcriptionTranscript.createdAt),
      desc(transcriptionTranscript.id)
    )
}

export async function findTranscript(
  componentId: string,
  userId: string,
  id: string
): Promise<TranscriptRow | null> {
  const [row] = await db
    .select()
    .from(transcriptionTranscript)
    .where(and(ownedBy(componentId, userId), eq(transcriptionTranscript.id, id)))
    .limit(1)
  return row ?? null
}

/** What saving needs to know about each job of a group. */
export interface GroupJob {
  id: string
  filename: string
  size: number
  status: TranscriptionJobStatus
  transcriptId: string | null
  result: TranscriptionResult | null
}

/** A transcript's columns as saving writes them. */
export interface NewTranscript {
  title: string
  language: string | null
  duration: number | null
  model: string | null
  provider: string | null
  originalFilename: string | null
  fileSize: number | null
  segments: TranscriptionSegment[]
  words: TranscriptionWord[]
  text: string
  sourceFiles: TranscriptionSourceFile[]
  speakerColors: TranscriptionSpeakerColorMap
  userLocale: string | null
  expiresAt: Date | null
}

/**
 * Saves a group's result once. The transcript saved first under `idempotencyKey` comes back
 * (`created: false`) instead of a second one. Otherwise the user's jobs of the group are locked
 * (`FOR UPDATE`) and handed to `build`, which checks them (throwing to refuse) and returns the
 * columns; the jobs then point at the new transcript and no longer expire. Only jobs neither deleted
 * nor expired are found, so a job the cleanup claimed (`claimJobsForCleanup`) cannot be saved, and
 * while the lock is held the cleanup cannot claim the jobs.
 */
export async function saveTranscript(
  componentId: string,
  userId: string,
  idempotencyKey: string,
  jobIds: readonly string[],
  build: (jobs: GroupJob[]) => NewTranscript
): Promise<{ row: TranscriptRow; created: boolean }> {
  return db.transaction(async (tx) => {
    const byKey = and(
      eq(transcriptionTranscript.userId, userId),
      eq(transcriptionTranscript.idempotencyKey, idempotencyKey)
    )
    const [existing] = await tx.select().from(transcriptionTranscript).where(byKey).limit(1)
    if (existing) return { row: existing, created: false }

    const jobs = await tx
      .select({
        id: transcriptionJob.id,
        filename: transcriptionJob.filename,
        size: transcriptionJob.size,
        status: transcriptionJob.status,
        transcriptId: transcriptionJob.transcriptId,
        result: transcriptionJob.result
      })
      .from(transcriptionJob)
      .where(
        and(
          eq(transcriptionJob.componentId, componentId),
          eq(transcriptionJob.userId, userId),
          inArray(transcriptionJob.id, [...jobIds]),
          visibleJob(new Date())
        )
      )
      .for('update')
    const values = build(
      jobs.map((job) => ({ ...job, status: job.status as TranscriptionJobStatus }))
    )

    const [row] = await tx
      .insert(transcriptionTranscript)
      .values({ componentId, userId, idempotencyKey, ...values })
      .onConflictDoNothing({
        target: [transcriptionTranscript.userId, transcriptionTranscript.idempotencyKey]
      })
      .returning()
    if (!row) {
      // A parallel request with the same key won.
      const [winner] = await tx.select().from(transcriptionTranscript).where(byKey).limit(1)
      if (!winner) throw new Error('Transcript saved in parallel is missing')
      return { row: winner, created: false }
    }
    await tx
      .update(transcriptionJob)
      .set({ transcriptId: row.id, expiresAt: null, updatedAt: new Date() })
      .where(
        inArray(
          transcriptionJob.id,
          jobs.map((job) => job.id)
        )
      )
    return { row, created: true }
  })
}

/** Columns a `PATCH` changes. */
export interface TranscriptChanges {
  title?: string
  subtitle?: string | null
  subtitleSource?: 'ai' | 'manual' | null
  segments?: TranscriptionSegment[]
  text?: string
  speakerColors?: TranscriptionSpeakerColorMap
  summaryTemplateId?: string | null
}

/**
 * Applies changes if the transcript is still at `baseRevision` (`null`: at any); `null` when it
 * is not (or gone).
 * `bump` raises the revision and the change time, which only the choice of summary template
 * leaves alone, so stored summaries stay valid.
 */
export async function updateTranscript(
  componentId: string,
  userId: string,
  id: string,
  baseRevision: number | null,
  changes: TranscriptChanges,
  options: { bump: boolean; retentionHours: number | null }
): Promise<TranscriptRow | null> {
  const now = new Date()
  const [row] = await db
    .update(transcriptionTranscript)
    .set({
      ...changes,
      ...(options.bump
        ? {
            revision: sql`${transcriptionTranscript.revision} + 1`,
            updatedAt: now,
            expiresAt: retentionExpiry(now, options.retentionHours)
          }
        : {})
    })
    .where(
      and(
        ownedBy(componentId, userId),
        eq(transcriptionTranscript.id, id),
        baseRevision === null ? undefined : eq(transcriptionTranscript.revision, baseRevision)
      )
    )
    .returning()
  return row ?? null
}

/** Remembers the summary template last used, without counting as a change. */
export async function rememberSummaryTemplate(id: string, templateId: string): Promise<void> {
  await db
    .update(transcriptionTranscript)
    .set({ summaryTemplateId: templateId })
    .where(eq(transcriptionTranscript.id, id))
}

/**
 * Writes what the chat model generated after saving: the subtitle only while there is none (a
 * subtitle the user typed wins), the title only while it is still `titleWas`. Neither counts as a
 * change, so the user's next `PATCH` does not conflict.
 */
export async function applyGeneratedMetadata(
  id: string,
  generated: { subtitle: string | null; title: string | null; titleWas: string }
): Promise<void> {
  if (generated.subtitle) {
    await db
      .update(transcriptionTranscript)
      .set({ subtitle: generated.subtitle, subtitleSource: 'ai' })
      .where(and(eq(transcriptionTranscript.id, id), isNull(transcriptionTranscript.subtitle)))
  }
  if (generated.title) {
    await db
      .update(transcriptionTranscript)
      .set({ title: generated.title })
      .where(
        and(
          eq(transcriptionTranscript.id, id),
          eq(transcriptionTranscript.title, generated.titleWas)
        )
      )
  }
}

/** Replaces the subtitle with one the chat model wrote on request; the row after it. */
export async function setGeneratedSubtitle(
  componentId: string,
  userId: string,
  id: string,
  subtitle: string
): Promise<TranscriptRow | null> {
  const [row] = await db
    .update(transcriptionTranscript)
    .set({ subtitle, subtitleSource: 'ai' })
    .where(and(ownedBy(componentId, userId), eq(transcriptionTranscript.id, id)))
    .returning()
  return row ?? null
}

/**
 * Deletes transcripts (their summaries cascade). Their jobs leave every list and expire now, so
 * the job sweep deletes their audio. `userId` null: any user's, for the retention sweep.
 */
export async function deleteTranscripts(
  componentId: string,
  userId: string | null,
  ids: readonly string[]
): Promise<number> {
  if (ids.length === 0) return 0
  return db.transaction(async (tx) => {
    const owned = await tx
      .select({ id: transcriptionTranscript.id })
      .from(transcriptionTranscript)
      .where(
        and(
          eq(transcriptionTranscript.componentId, componentId),
          userId === null ? undefined : eq(transcriptionTranscript.userId, userId),
          inArray(transcriptionTranscript.id, [...ids])
        )
      )
      .for('update')
    const ownedIds = owned.map((row) => row.id)
    if (ownedIds.length === 0) return 0
    const now = new Date()
    await tx
      .update(transcriptionJob)
      .set({ deletedAt: now, expiresAt: now, updatedAt: now })
      .where(inArray(transcriptionJob.transcriptId, ownedIds))
    await tx.delete(transcriptionTranscript).where(inArray(transcriptionTranscript.id, ownedIds))
    return ownedIds.length
  })
}

/** Transcripts whose last change lies before `cutoff`, for the retention sweep. */
export async function staleTranscriptIds(
  componentId: string,
  cutoff: Date,
  limit: number
): Promise<string[]> {
  const rows = await db
    .select({ id: transcriptionTranscript.id })
    .from(transcriptionTranscript)
    .where(
      and(
        eq(transcriptionTranscript.componentId, componentId),
        lt(transcriptionTranscript.updatedAt, cutoff)
      )
    )
    .limit(limit)
  return rows.map((row) => row.id)
}
