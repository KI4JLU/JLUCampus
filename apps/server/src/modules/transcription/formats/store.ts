import {
  TRANSCRIPTION_FORMAT_NAME_MAX,
  transcriptionFormatSchema,
  type TranscriptFormatFlags,
  type TranscriptionFormat
} from '@justcampus/shared'
import { and, asc, eq } from 'drizzle-orm'

import { db } from '../../../db/index.js'
import { transcriptionFormat } from '../../../db/schema.js'

/** The users' own transcript export formats (T-45). Which speakers are shown is never stored. */

export type FormatRow = typeof transcriptionFormat.$inferSelect

export function publicFormat(row: FormatRow): TranscriptionFormat {
  return transcriptionFormatSchema.parse({
    id: row.id,
    name: row.name,
    speakers: row.speakers,
    timestamps: row.timestamps,
    avatars: row.avatars,
    bubbles: row.bubbles,
    anonymize: row.anonymize,
    order: row.order,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  })
}

/**
 * kiChat's duplicate rule: a name another format already has, in any case, becomes `Name (1)`,
 * `Name (2)`, … The base is shortened where the suffix would pass the length limit.
 */
export function uniqueFormatName(name: string, taken: readonly string[]): string {
  const names = new Set(taken.map((other) => other.toLowerCase()))
  if (!names.has(name.toLowerCase())) return name
  for (let counter = 1; ; counter += 1) {
    const suffix = ` (${counter})`
    const candidate = `${name.slice(0, TRANSCRIPTION_FORMAT_NAME_MAX - suffix.length).trimEnd()}${suffix}`
    if (!names.has(candidate.toLowerCase())) return candidate
  }
}

/** The user's formats, oldest first. */
export async function listFormats(
  componentId: string,
  userId: string
): Promise<TranscriptionFormat[]> {
  const rows = await db
    .select()
    .from(transcriptionFormat)
    .where(
      and(eq(transcriptionFormat.componentId, componentId), eq(transcriptionFormat.userId, userId))
    )
    .orderBy(asc(transcriptionFormat.createdAt), asc(transcriptionFormat.id))
  return rows.map(publicFormat)
}

export interface FormatValues extends TranscriptFormatFlags {
  name: string
}

/**
 * Creates a format (`id` null) or changes one of the user's own; `null` when `id` names none of
 * theirs. The name is made unique among the user's other formats.
 */
export async function saveFormat(
  componentId: string,
  userId: string,
  id: string | null,
  values: FormatValues
): Promise<TranscriptionFormat | null> {
  return db.transaction(async (tx) => {
    const owned = and(
      eq(transcriptionFormat.componentId, componentId),
      eq(transcriptionFormat.userId, userId)
    )
    const others = await tx
      .select({ id: transcriptionFormat.id, name: transcriptionFormat.name })
      .from(transcriptionFormat)
      .where(owned)
      .for('update')
    if (id !== null && !others.some((other) => other.id === id)) return null
    const name = uniqueFormatName(
      values.name,
      others.filter((other) => other.id !== id).map((other) => other.name)
    )
    const flags = {
      name,
      speakers: values.speakers,
      timestamps: values.timestamps,
      avatars: values.avatars,
      bubbles: values.bubbles,
      anonymize: values.anonymize,
      order: values.order
    }
    const [row] =
      id === null
        ? await tx
            .insert(transcriptionFormat)
            .values({ componentId, userId, ...flags })
            .returning()
        : await tx
            .update(transcriptionFormat)
            .set({ ...flags, updatedAt: new Date() })
            .where(and(owned, eq(transcriptionFormat.id, id)))
            .returning()
    return row ? publicFormat(row) : null
  })
}

/** Deletes one of the user's formats; whether there was one. */
export async function deleteFormat(
  componentId: string,
  userId: string,
  id: string
): Promise<boolean> {
  const deleted = await db
    .delete(transcriptionFormat)
    .where(
      and(
        eq(transcriptionFormat.componentId, componentId),
        eq(transcriptionFormat.userId, userId),
        eq(transcriptionFormat.id, id)
      )
    )
    .returning({ id: transcriptionFormat.id })
  return deleted.length > 0
}
