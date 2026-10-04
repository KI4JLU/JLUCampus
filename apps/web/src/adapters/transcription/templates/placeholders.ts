import {
  fillTemplatePlaceholders,
  TRANSCRIPTION_TEMPLATE_PLACEHOLDERS,
  type TranscriptionPlaceholder,
  type TranscriptionSegment
} from '@justcampus/shared'

/**
 * The template editor's placeholders (T-52): `{{title}}`, `{{date}}`, `{{participants}}` and
 * `{{duration}}`, with kiChat's German aliases. The preview fills them with the open transcript's
 * facts, as the server fills the summary; kiChat's sample values only stand in while no
 * transcript is open.
 */

export const PLACEHOLDERS = Object.keys(
  TRANSCRIPTION_TEMPLATE_PLACEHOLDERS
) as TranscriptionPlaceholder[]

/** The token a palette button inserts. */
export function placeholderToken(placeholder: TranscriptionPlaceholder): string {
  return TRANSCRIPTION_TEMPLATE_PLACEHOLDERS[placeholder][0]
}

/** kiChat's preview samples, used only without a transcript. */
export const SAMPLE_TITLE = 'Interview zu Innovation & Musiktechnologie'
export const SAMPLE_PARTICIPANTS = 'Sten, Soria, Nadia'
export const SAMPLE_DURATION_SECONDS = 2700
/** The server's duration without one (`minutesText`). */
export const UNKNOWN_DURATION = '–'

export interface PlaceholderSource {
  title: string | null
  /** When the transcript was made. */
  createdAt: string | null
  segments: readonly Pick<TranscriptionSegment, 'speaker'>[]
  /** Seconds; `null`: not known. */
  duration: number | null
}

export interface PlaceholderTexts {
  /** `45 Min`. */
  minutes: (count: number) => string
  /** A fact the transcript does not have, as the server says it (`Unbekannt`). */
  unknown: string
}

/**
 * The values of the placeholders: the title, the date in the language's short form, the named
 * speakers in order of appearance and the rounded minutes. A transcript's missing facts stay
 * unknown, as in the generated summary; `null` (no transcript open) gives kiChat's samples.
 */
export function placeholderValues(
  source: PlaceholderSource | null,
  language: string,
  texts: PlaceholderTexts,
  now: Date = new Date()
): Record<TranscriptionPlaceholder, string> {
  const locale = language === 'de' ? 'de-DE' : language
  if (!source) {
    return {
      title: SAMPLE_TITLE,
      date: now.toLocaleDateString(locale),
      participants: SAMPLE_PARTICIPANTS,
      duration: texts.minutes(Math.round(SAMPLE_DURATION_SECONDS / 60))
    }
  }
  const created = source.createdAt ? new Date(source.createdAt) : null
  const speakers = [...new Set(source.segments.flatMap((segment) => segment.speaker?.trim() || []))]
  return {
    title: source.title?.trim() || texts.unknown,
    date:
      created && !Number.isNaN(created.getTime())
        ? created.toLocaleDateString(locale)
        : texts.unknown,
    participants: speakers.length > 0 ? speakers.join(', ') : texts.unknown,
    duration:
      source.duration === null ? UNKNOWN_DURATION : texts.minutes(Math.round(source.duration / 60))
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
