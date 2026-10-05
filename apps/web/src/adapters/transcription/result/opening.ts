import type { TranscriptionTranscript } from '@justcampus/shared'

/**
 * Which copy of a server transcript a new session opens with (T-39): the one loaded since the view
 * opened, as the server is authoritative; after a transient failure the newer of the copy this
 * browser kept and the one loaded earlier in this tab; `null` while loading, and when nothing
 * stands in. A transcript that is gone (404/410) never gets here.
 */
export function openingCopy(input: {
  /** The loaded detail, if it was fetched since the view opened. */
  fresh: TranscriptionTranscript | null
  /** Loading failed, and not because the transcript is gone. */
  failed: boolean
  kept: TranscriptionTranscript | null
  earlier: TranscriptionTranscript | null
}): { transcript: TranscriptionTranscript; fallback: boolean } | null {
  if (input.fresh && !input.failed) return { transcript: input.fresh, fallback: false }
  if (!input.failed) return null
  const { kept, earlier } = input
  const stand =
    kept && earlier ? (earlier.revision > kept.revision ? earlier : kept) : (kept ?? earlier)
  return stand ? { transcript: stand, fallback: true } : null
}

/** When the admin's retention deletes a transcript, as a date and time in the UI language (T-23). */
export function formatExpiry(expiresAt: string, language: string): string {
  const date = new Date(expiresAt)
  if (Number.isNaN(date.getTime())) return expiresAt
  return new Intl.DateTimeFormat(language, { dateStyle: 'long', timeStyle: 'short' }).format(date)
}
