import type { TranscriptionTranscript } from '@justcampus/shared'

/** JSON with object keys sorted, so values compare equal whatever order the database kept. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_, inner: unknown) => {
    if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return inner
    return Object.fromEntries(
      Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))
    )
  })
}

/**
 * Whether two server copies of a transcript have the same segments and colours, i.e. whatever
 * changed between them (a new revision) was only its title, subtitle or other details.
 */
export function sameContent(
  a: Pick<TranscriptionTranscript, 'segments' | 'speakerColors'>,
  b: Pick<TranscriptionTranscript, 'segments' | 'speakerColors'>
): boolean {
  return (
    stableStringify(a.segments) === stableStringify(b.segments) &&
    stableStringify(a.speakerColors) === stableStringify(b.speakerColors)
  )
}
