import {
  TRANSCRIPTION_BUILTIN_TEMPLATES,
  transcriptionTemplateSchema,
  type TranscriptionTemplate,
  type TranscriptionTemplateBlock
} from '@justcampus/shared'
import { randomUUID } from 'node:crypto'
import { and, asc, eq, isNull, or, sql, type SQL } from 'drizzle-orm'

import { db } from '../../../db/index.js'
import { transcriptionSummary, transcriptionTemplate } from '../../../db/schema.js'

/**
 * Summary templates: kiChat's five built-ins, which live in code and never change (version 1), and
 * the users' own rows. A row without a user would be an admin-wide template, read-only like a
 * built-in. Users only ever see the built-ins and their own (T-54).
 */

export type TemplateRow = typeof transcriptionTemplate.$inferSelect

/** The built-ins as API records, in kiChat's order. */
export const BUILTIN_TEMPLATES: readonly TranscriptionTemplate[] =
  TRANSCRIPTION_BUILTIN_TEMPLATES.map((template) =>
    transcriptionTemplateSchema.parse({
      id: template.id,
      name: template.name,
      description: template.description,
      builtIn: true,
      structure: template.structure,
      version: 1,
      outputFormatHints: null,
      createdAt: null,
      updatedAt: null
    })
  )

export function builtInTemplate(id: string): TranscriptionTemplate | null {
  return BUILTIN_TEMPLATES.find((template) => template.id === id) ?? null
}

export function publicTemplate(row: TemplateRow): TranscriptionTemplate {
  return transcriptionTemplateSchema.parse({
    id: row.id,
    name: row.name,
    description: row.description,
    builtIn: row.userId === null,
    structure: row.structure,
    version: row.version,
    outputFormatHints: row.outputFormatHints,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  })
}

/**
 * Gives every AI section an id, so previews and their cache can name it even where headings repeat.
 * Ids already there stay.
 */
export function withSectionIds(
  structure: readonly TranscriptionTemplateBlock[]
): TranscriptionTemplateBlock[] {
  const used = new Set<string>()
  return structure.map((block) => {
    if (block.type !== 'section') return block
    const id = block.id && !used.has(block.id) ? block.id : randomUUID()
    used.add(id)
    return { ...block, id }
  })
}

/** The user's own rows and admin-wide ones. */
function usableBy(userId: string): SQL | undefined {
  return or(eq(transcriptionTemplate.userId, userId), isNull(transcriptionTemplate.userId))
}

/** The built-ins, then admin-wide rows, then the user's own, oldest first. */
export async function listTemplates(
  componentId: string,
  userId: string
): Promise<TranscriptionTemplate[]> {
  const rows = await db
    .select()
    .from(transcriptionTemplate)
    .where(and(eq(transcriptionTemplate.componentId, componentId), usableBy(userId)))
    .orderBy(
      sql`${transcriptionTemplate.userId} is not null`,
      asc(transcriptionTemplate.createdAt),
      asc(transcriptionTemplate.id)
    )
  return [...BUILTIN_TEMPLATES, ...rows.map(publicTemplate)]
}

/**
 * A template the user may use: a built-in, an admin-wide row or one of their own. `own` tells
 * whether they may change it. `null` for anything else, other users' templates included.
 */
export async function findTemplate(
  componentId: string,
  userId: string,
  id: string
): Promise<{ template: TranscriptionTemplate; own: boolean } | null> {
  const builtIn = builtInTemplate(id)
  if (builtIn) return { template: builtIn, own: false }
  const [row] = await db
    .select()
    .from(transcriptionTemplate)
    .where(
      and(
        eq(transcriptionTemplate.componentId, componentId),
        eq(transcriptionTemplate.id, id),
        usableBy(userId)
      )
    )
    .limit(1)
  return row ? { template: publicTemplate(row), own: row.userId === userId } : null
}

export interface TemplateValues {
  name: string
  description: string
  structure: TranscriptionTemplateBlock[]
}

export async function insertTemplate(
  componentId: string,
  userId: string,
  values: TemplateValues
): Promise<TranscriptionTemplate> {
  const [row] = await db
    .insert(transcriptionTemplate)
    .values({
      id: randomUUID(),
      componentId,
      userId,
      name: values.name,
      description: values.description,
      structure: withSectionIds(values.structure),
      version: 1
    })
    .returning()
  return publicTemplate(row!)
}

/** Changes one of the user's own templates and raises its version; `null` if there is none. */
export async function updateTemplate(
  componentId: string,
  userId: string,
  id: string,
  values: TemplateValues
): Promise<TranscriptionTemplate | null> {
  const [row] = await db
    .update(transcriptionTemplate)
    .set({
      name: values.name,
      description: values.description,
      structure: withSectionIds(values.structure),
      version: sql`${transcriptionTemplate.version} + 1`,
      updatedAt: new Date()
    })
    .where(
      and(
        eq(transcriptionTemplate.componentId, componentId),
        eq(transcriptionTemplate.userId, userId),
        eq(transcriptionTemplate.id, id)
      )
    )
    .returning()
  return row ? publicTemplate(row) : null
}

/** Deletes one of the user's own templates and its stored summaries; whether there was one. */
export async function deleteTemplate(
  componentId: string,
  userId: string,
  id: string
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const deleted = await tx
      .delete(transcriptionTemplate)
      .where(
        and(
          eq(transcriptionTemplate.componentId, componentId),
          eq(transcriptionTemplate.userId, userId),
          eq(transcriptionTemplate.id, id)
        )
      )
      .returning({ id: transcriptionTemplate.id })
    if (deleted.length === 0) return false
    await tx
      .delete(transcriptionSummary)
      .where(
        and(
          eq(transcriptionSummary.componentId, componentId),
          eq(transcriptionSummary.userId, userId),
          eq(transcriptionSummary.templateId, id)
        )
      )
    return true
  })
}
