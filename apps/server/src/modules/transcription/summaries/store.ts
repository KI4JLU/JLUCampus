import { and, desc, eq, isNull, ne, type SQL } from 'drizzle-orm'

import { db } from '../../../db/index.js'
import { transcriptionSummary } from '../../../db/schema.js'

/**
 * Stored summaries and section previews of saved transcripts. A summary is found again only for
 * the same transcript revision, template version, model and settings, so any edit makes it stale
 * without touching it; storing a new one replaces the older ones of that transcript and template.
 * Previews are one row per transcript revision and model, keyed by heading and instruction.
 */

/** `templateId` of preview rows, which belong to no template. */
const PREVIEW_TEMPLATE = 'preview'

export interface SummaryKey {
  componentId: string
  userId: string
  transcriptId: string
  templateId: string
  templateVersion: number
  transcriptRevision: number
  model: string | null
  settingsHash: string
}

export interface StoredSummary {
  markdown: string
  generatedAt: Date
}

function sameModel(model: string | null): SQL {
  return model === null ? isNull(transcriptionSummary.model) : eq(transcriptionSummary.model, model)
}

export async function findSummary(key: SummaryKey): Promise<StoredSummary | null> {
  const [row] = await db
    .select({
      markdown: transcriptionSummary.markdown,
      generatedAt: transcriptionSummary.generatedAt
    })
    .from(transcriptionSummary)
    .where(
      and(
        eq(transcriptionSummary.componentId, key.componentId),
        eq(transcriptionSummary.userId, key.userId),
        eq(transcriptionSummary.transcriptId, key.transcriptId),
        eq(transcriptionSummary.kind, 'summary'),
        eq(transcriptionSummary.templateId, key.templateId),
        eq(transcriptionSummary.templateVersion, key.templateVersion),
        eq(transcriptionSummary.transcriptRevision, key.transcriptRevision),
        sameModel(key.model),
        eq(transcriptionSummary.settingsHash, key.settingsHash)
      )
    )
    .orderBy(desc(transcriptionSummary.generatedAt))
    .limit(1)
  return row && row.markdown !== null
    ? { markdown: row.markdown, generatedAt: row.generatedAt }
    : null
}

/** Stores a summary in place of the transcript's older ones of that template. */
export async function storeSummary(
  key: SummaryKey,
  markdown: string,
  generatedAt: Date
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(transcriptionSummary)
      .where(
        and(
          eq(transcriptionSummary.transcriptId, key.transcriptId),
          eq(transcriptionSummary.kind, 'summary'),
          eq(transcriptionSummary.templateId, key.templateId)
        )
      )
    await tx.insert(transcriptionSummary).values({ ...key, kind: 'summary', markdown, generatedAt })
  })
}

export interface PreviewKey {
  componentId: string
  userId: string
  transcriptId: string
  transcriptRevision: number
  model: string | null
}

/** Stored previews of a transcript revision and model, by section key. */
export async function findPreviews(key: PreviewKey): Promise<Record<string, string>> {
  const [row] = await db
    .select({ sections: transcriptionSummary.sections })
    .from(transcriptionSummary)
    .where(
      and(
        eq(transcriptionSummary.componentId, key.componentId),
        eq(transcriptionSummary.userId, key.userId),
        eq(transcriptionSummary.transcriptId, key.transcriptId),
        eq(transcriptionSummary.kind, 'preview'),
        eq(transcriptionSummary.transcriptRevision, key.transcriptRevision),
        sameModel(key.model)
      )
    )
    .orderBy(desc(transcriptionSummary.generatedAt))
    .limit(1)
  return row?.sections ?? {}
}

/**
 * Adds previews to the stored ones of that revision and model; previews of older revisions go.
 * Rows are written whole, so two previews at once may lose one another's sections, which only
 * costs a later request.
 */
export async function storePreviews(
  key: PreviewKey,
  sections: Record<string, string>
): Promise<void> {
  if (Object.keys(sections).length === 0) return
  await db.transaction(async (tx) => {
    const ofTranscript = and(
      eq(transcriptionSummary.transcriptId, key.transcriptId),
      eq(transcriptionSummary.kind, 'preview')
    )
    const [current] = await tx
      .select({ id: transcriptionSummary.id, sections: transcriptionSummary.sections })
      .from(transcriptionSummary)
      .where(
        and(
          ofTranscript,
          eq(transcriptionSummary.transcriptRevision, key.transcriptRevision),
          sameModel(key.model)
        )
      )
      .limit(1)
      .for('update')
    await tx
      .delete(transcriptionSummary)
      .where(and(ofTranscript, ne(transcriptionSummary.transcriptRevision, key.transcriptRevision)))
    if (current) {
      await tx
        .update(transcriptionSummary)
        .set({ sections: { ...(current.sections ?? {}), ...sections }, generatedAt: new Date() })
        .where(eq(transcriptionSummary.id, current.id))
      return
    }
    await tx.insert(transcriptionSummary).values({
      ...key,
      kind: 'preview',
      templateId: PREVIEW_TEMPLATE,
      templateVersion: 1,
      settingsHash: PREVIEW_TEMPLATE,
      sections
    })
  })
}
