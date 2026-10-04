import { z } from 'zod'
import type { TranscriptionTemplateSection } from '@justcampus/shared'

/**
 * The template editor's AI section previews, kept in `localStorage` like kiChat's
 * `hawki_template_preview_cache` (T-53): per transcript, template name and section the output and
 * a hash of the instruction it was made with. A changed instruction makes the output stale.
 * kiChat keyed sections by heading; headings need not be unique, so Campus keys them by the
 * section's id, which the editor keeps across saves (`toEditorBlocks`). Campus keys the store by user and module, so one browser shared by several people shows
 * nobody another person's transcript, and sign-out clears it (`clearPreviewCaches`).
 */

/** kiChat's key; Campus adds `:<user>:<module>`. */
export const PREVIEW_CACHE_KEY = 'hawki_template_preview_cache'

/** The start of every key of one user's previews. */
export function userCachePrefix(userId: string): string {
  return `${PREVIEW_CACHE_KEY}:${userId}:`
}

export function previewCacheKey(userId: string, componentId: string): string {
  return `${userCachePrefix(userId)}${componentId}`
}

/** kiChat's `getStringHash`: a 32-bit Java-style string hash in decimal. */
export function stringHash(text: string): string {
  let hash = 0
  for (let index = 0; index < text.length; index++) {
    hash = (hash << 5) - hash + text.charCodeAt(index)
    hash |= 0
  }
  return hash.toString()
}

const cachedSectionSchema = z.object({ instructionHash: z.string(), output: z.string() })
const previewCacheSchema = z.record(
  z.string(),
  z.record(z.string(), z.record(z.string(), cachedSectionSchema))
)
export type CachedSection = z.infer<typeof cachedSectionSchema>
/** transcript → template name → section id → output. */
export type PreviewCache = z.infer<typeof previewCacheSchema>

/** What `localStorage` offers that the cache uses; tests pass a map. */
export type PreviewStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>

export function readPreviewCache(storage: PreviewStorage, key: string): PreviewCache {
  try {
    const parsed = previewCacheSchema.safeParse(JSON.parse(storage.getItem(key) ?? '{}'))
    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}

export function writePreviewCache(storage: PreviewStorage, key: string, cache: PreviewCache): void {
  try {
    storage.setItem(key, JSON.stringify(cache))
  } catch {
    // A full or blocked storage keeps the previews for this visit only.
  }
}

/**
 * Removes the preview stores, except those starting with `keep`: other users' when one user opens
 * the editor, all of them on sign-out.
 */
export function clearPreviewCaches(storage: PreviewStorage, keep?: string): void {
  const keys: string[] = []
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index)
    if (key?.startsWith(PREVIEW_CACHE_KEY) && !(keep && key.startsWith(keep))) keys.push(key)
  }
  for (const key of keys) storage.removeItem(key)
}

/** Where a section's preview stands: none yet, current, or made with another instruction. */
export type SectionPreviewStatus = 'empty' | 'fresh' | 'stale'

export interface SectionPreview {
  status: SectionPreviewStatus
  output: string
}

/** The names a cache is keyed by, kiChat's fallbacks for missing ones. */
export function cacheScope(transcriptId: string | null, templateName: string): [string, string] {
  return [transcriptId || 'preview-default', templateName.trim() || 'default']
}

/** A section as the cache knows it: its id and the instruction its output depends on. */
export type CachedSectionRef = Pick<TranscriptionTemplateSection, 'instruction'> & { id: string }

export function sectionPreview(
  cache: PreviewCache,
  transcriptId: string | null,
  templateName: string,
  section: CachedSectionRef
): SectionPreview {
  const [transcript, template] = cacheScope(transcriptId, templateName)
  const cached = cache[transcript]?.[template]?.[section.id]
  if (!cached) return { status: 'empty', output: '' }
  return {
    status: cached.instructionHash === stringHash(section.instruction) ? 'fresh' : 'stale',
    output: cached.output
  }
}

/** The sections a test preview has to make: those without a current output. */
export function staleSections<T extends CachedSectionRef>(
  cache: PreviewCache,
  transcriptId: string | null,
  templateName: string,
  sections: readonly T[]
): T[] {
  return sections.filter(
    (section) => sectionPreview(cache, transcriptId, templateName, section).status !== 'fresh'
  )
}

/**
 * The cache with the outputs of a preview answer, by section id: only for the sections that were
 * asked for, each with the hash of the instruction it was asked with.
 */
export function withPreviewResults(
  cache: PreviewCache,
  transcriptId: string | null,
  templateName: string,
  requested: readonly { id: string; heading: string; instruction: string }[],
  results: Readonly<Record<string, string>>
): PreviewCache {
  const [transcript, template] = cacheScope(transcriptId, templateName)
  const sections = { ...cache[transcript]?.[template] }
  for (const section of requested) {
    const output = results[section.id]
    if (output === undefined) continue
    sections[section.id] = { instructionHash: stringHash(section.instruction), output }
  }
  return { ...cache, [transcript]: { ...cache[transcript], [template]: sections } }
}
