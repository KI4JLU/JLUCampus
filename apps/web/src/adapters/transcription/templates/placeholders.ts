import {
  fillTemplatePlaceholders,
  TRANSCRIPTION_TEMPLATE_PLACEHOLDERS,
  type TranscriptionPlaceholder,
  type TranscriptionSegment
} from '@justcampus/shared'

/**
 * The template editor's placeholders (T-52): `{{title}}`, `{{date}}`, `{{participants}}` and
 * `{{duration}}`, with kiChat's German aliases. The preview fills them with the open transcript's
 * facts and falls back to kiChat's sample values where it has none.
 */

export const PLACEHOLDERS = Object.keys(
  TRANSCRIPTION_TEMPLATE_PLACEHOLDERS
) as TranscriptionPlaceholder[]

/** The token a palette button inserts. */
export function placeholderToken(placeholder: TranscriptionPlaceholder): string {
  return TRANSCRIPTION_TEMPLATE_PLACEHOLDERS[placeholder][0]
}

/** kiChat's preview samples, used only where the transcript has no value. */
export const SAMPLE_TITLE = 'Interview zu Innovation & Musiktechnologie'
export const SAMPLE_PARTICIPANTS = 'Sten, Soria, Nadia'
export const SAMPLE_DURATION_SECONDS = 2700

export interface PlaceholderSource {
  title: string | null
  /** When the transcript was made; `null`: today. */
  createdAt: string | null
  segments: readonly Pick<TranscriptionSegment, 'speaker'>[]
  /** Seconds; `null` or 0: the sample's 45 minutes. */
  duration: number | null
}

/**
 * The values of the placeholders: the title, the date in the language's short form, the named
 * speakers in order of appearance and the rounded minutes (`45 Min`).
 */
export function placeholderValues(
  source: PlaceholderSource,
  language: string,
  minutes: (count: number) => string,
  now: Date = new Date()
): Record<TranscriptionPlaceholder, string> {
  const created = source.createdAt ? new Date(source.createdAt) : now
  const date = (Number.isNaN(created.getTime()) ? now : created).toLocaleDateString(
    language === 'de' ? 'de-DE' : language
  )
  const speakers = [
    ...new Set(source.segments.flatMap((segment) => (segment.speaker ? [segment.speaker] : [])))
  ]
  return {
    title: source.title?.trim() || SAMPLE_TITLE,
    date,
    participants: speakers.length > 0 ? speakers.join(', ') : SAMPLE_PARTICIPANTS,
    duration: minutes(Math.round((source.duration || SAMPLE_DURATION_SECONDS) / 60))
  }
}

/** Replaces every placeholder and alias in a text. */
export function fillPlaceholders(
  text: string,
  values: Record<TranscriptionPlaceholder, string>
): string {
  return fillTemplatePlaceholders(text, values)
}

/**
 * A token put in place of the selection of a field's value; the cursor goes behind it.
 */
export function insertToken(
  value: string,
  selectionStart: number | null,
  selectionEnd: number | null,
  token: string
): { value: string; cursor: number } {
  const start = Math.min(value.length, Math.max(0, selectionStart ?? value.length))
  const end = Math.min(value.length, Math.max(start, selectionEnd ?? start))
  return { value: value.slice(0, start) + token + value.slice(end), cursor: start + token.length }
}
