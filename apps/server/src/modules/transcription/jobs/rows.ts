import {
  TRANSCRIPTION_UPLOAD_URL_TTL_SECONDS,
  transcriptionJobSchema,
  type TranscriptionJob,
  type TranscriptionJobStatus
} from '@justcampus/shared'

import type { transcriptionJob } from '../../../db/schema.js'

export type JobRow = typeof transcriptionJob.$inferSelect

/** When an unsaved job and its audio go: `hours` after its last step (as kiChat, 24 h). */
export function jobExpiry(hours: number, now = new Date()): Date {
  return new Date(now.getTime() + hours * 60 * 60 * 1000)
}

/**
 * How long after a job's creation its signed upload may still write the audio: the URL's lifetime,
 * plus time for a `PUT` started just before it expired (500 MB at about 1 Mbit/s take 70 min).
 */
export const UPLOAD_SETTLE_MS = (TRANSCRIPTION_UPLOAD_URL_TTL_SECONDS + 2 * 60 * 60) * 1000

/**
 * Whether no signed upload of a job created then can store anything any more (T-08): until then a
 * deleted job's row stays, so the sweep deletes what such an upload stored after the deletion.
 */
export function uploadSettled(createdAt: Date, now = new Date()): boolean {
  return createdAt.getTime() <= now.getTime() - UPLOAD_SETTLE_MS
}

/**
 * A job as the API shows it: no object keys, claims or upstream ids. `result` only in the answer
 * of `GET TRANSCRIPTION_API.job`; lists leave it out.
 */
export function publicJob(row: JobRow, withResult: boolean): TranscriptionJob {
  return transcriptionJobSchema.parse({
    id: row.id,
    filename: row.filename,
    size: Number(row.size),
    mimeType: row.mimeType,
    duration: row.duration,
    groupId: row.groupId,
    groupOrder: row.groupOrder,
    settings: row.settings,
    status: row.status as TranscriptionJobStatus,
    progress: row.progress ?? null,
    speakers: row.speakers,
    mapping: row.mapping,
    snippets: row.snippets,
    colors: row.colors,
    error: row.error ?? null,
    result: withResult && row.status === 'completed' ? (row.result ?? null) : null,
    transcriptId: row.transcriptId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null
  })
}
