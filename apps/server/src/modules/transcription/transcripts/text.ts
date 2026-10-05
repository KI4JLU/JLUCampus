import {
  TRANSCRIPTION_REDACTED_TEXT,
  type TranscriptionPlaceholder,
  type TranscriptionSegment
} from '@justcampus/shared'

/**
 * Text of saved transcripts as the server hands it to the chat model: redactions replaced, one
 * line per speaker turn. kiChat assembles the text of unsaved transcripts the same way in the
 * browser (`generateErgebnisprotokoll`), so both kinds read alike.
 */

type SegmentText = Pick<TranscriptionSegment, 'text' | 'redactions'>

/**
 * A segment's text with every redacted range replaced by `[AUSGEBLENDET]`, trimmed (T-33).
 * Overlapping or touching ranges give one marker.
 */
export function redactedText(
  segment: SegmentText,
  replacement: string = TRANSCRIPTION_REDACTED_TEXT
): string {
  const ranges = [...(segment.redactions ?? [])].sort((a, b) => a.start - b.start)
  let result = ''
  let position = 0
  let marked = false
  for (const range of ranges) {
    if (marked && range.start <= position) {
      position = Math.max(position, range.end)
      continue
    }
    result += segment.text.slice(position, range.start) + replacement
    position = range.end
    marked = true
  }
  return (result + segment.text.slice(position)).trim()
}

/** The plain text of all segments, as stored with the transcript: unredacted, one space apart. */
export function plainText(segments: readonly Pick<TranscriptionSegment, 'text'>[]): string {
  return segments
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join(' ')
}

/** What kiChat calls a speaker it does not know. */
export const UNKNOWN_SPEAKER = 'Unbekannt'

/** A new turn starts with another speaker or after this much silence (kiChat: 10 s). */
const TURN_GAP_SECONDS = 10

/**
 * `Name: text` lines, one per speaker turn, redactions applied. Consecutive segments of one
 * speaker form a turn unless more than ten seconds lie between them.
 */
export function speakerText(
  segments: readonly Pick<
    TranscriptionSegment,
    'start' | 'end' | 'speaker' | 'text' | 'redactions'
  >[]
): string {
  const lines: string[] = []
  let speaker: string | null = null
  let parts: string[] = []
  let previousEnd = 0
  segments.forEach((segment, index) => {
    const name = segment.speaker?.trim() || UNKNOWN_SPEAKER
    const text = redactedText(segment)
    if (index === 0 || name !== speaker || segment.start - previousEnd > TURN_GAP_SECONDS) {
      if (speaker !== null) lines.push(`${speaker}: ${parts.join(' ').trim()}`)
      speaker = name
      parts = []
    }
    if (text) parts.push(text)
    previousEnd = segment.end
  })
  if (speaker !== null) lines.push(`${speaker}: ${parts.join(' ').trim()}`)
  return lines.join('\n')
}

/** The named speakers in order of appearance. */
export function participants(segments: readonly Pick<TranscriptionSegment, 'speaker'>[]): string[] {
  const names = new Set<string>()
  for (const segment of segments) {
    const name = segment.speaker?.trim()
    if (name) names.add(name)
  }
  return [...names]
}

/** The speaker names of `Name: text` lines, for text an unsaved transcript sends. */
export function participantsOfText(text: string): string[] {
  const names = new Set<string>()
  for (const line of text.split('\n')) {
    const match = /^([^:\n]{1,100}):\s/.exec(line)
    const name = match?.[1]?.trim()
    if (name && name !== UNKNOWN_SPEAKER) names.add(name)
  }
  return [...names]
}

/** `dd.mm.yyyy` in Gießen's time zone, as kiChat writes dates. */
export function germanDate(date: Date): string {
  return date.toLocaleDateString('de-DE', {
    timeZone: 'Europe/Berlin',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  })
}

/**
 * kiChat's `{minutes} Min`, rounded; `< 1 Min` below a minute (kiChat says `0 Min` there), `–`
 * without a duration.
 */
export function minutesText(seconds: number | null): string {
  if (seconds === null) return '–'
  return seconds < 60 ? '< 1 Min' : `${Math.round(seconds / 60)} Min`
}

export type PlaceholderValues = Record<TranscriptionPlaceholder, string>

/** The placeholder values of a transcript, from its own data (never kiChat's sample values). */
export function placeholderValues(input: {
  title: string
  date: Date
  participants: readonly string[]
  duration: number | null
}): PlaceholderValues {
  return {
    title: input.title,
    date: germanDate(input.date),
    participants: input.participants.length > 0 ? input.participants.join(', ') : UNKNOWN_SPEAKER,
    duration: minutesText(input.duration)
  }
}
