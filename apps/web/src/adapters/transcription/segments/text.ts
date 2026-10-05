import { TRANSCRIPTION_EMPTY_SPEAKER_TEXT, type TranscriptionSegment } from '@justcampus/shared'

/**
 * Text helpers of kiChat's `SegmentProcessor` and `Utils`: how segment texts join into a block,
 * the placeholder of an empty speaker, timestamps and the plain text of a whole transcript.
 */

/** Whether a text is the stored placeholder of a speaker without text (T-27, T-30). */
export function isPlaceholder(text: string): boolean {
  return text.trim() === TRANSCRIPTION_EMPTY_SPEAKER_TEXT
}

/**
 * Whether a space goes between two segment texts of one block: neither side has one and the
 * second does not start with punctuation.
 */
export function needsSpace(before: string, after: string): boolean {
  return !before.endsWith(' ') && !after.startsWith(' ') && !/^[.,!?:;]/.test(after.trim())
}

/** The texts of one block joined as kiChat joins them: the first without leading blanks. */
export function joinTexts(texts: readonly string[]): string {
  let joined = ''
  texts.forEach((text, index) => {
    if (index === 0) {
      joined = text.trimStart()
      return
    }
    if (needsSpace(joined, text)) joined += ' '
    joined += text
  })
  return joined
}

/** `hh:mm:ss`, the timestamp of a speaker block (`[00:01:05]`). */
export function formatTimestamp(seconds: number): string {
  const value = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  const hours = String(Math.floor(value / 3600)).padStart(2, '0')
  const minutes = String(Math.floor((value % 3600) / 60)).padStart(2, '0')
  const rest = String(Math.floor(value % 60)).padStart(2, '0')
  return `${hours}:${minutes}:${rest}`
}

/** A corrected segment text: line breaks go, spaces stay (T-27). */
export function sanitizeSegmentText(text: string): string {
  return text.replace(/[\r\n]+/g, '')
}

/**
 * The plain text of a transcript, as kiChat stores it with every save: one paragraph per speaker
 * turn (a new speaker or a pause over two seconds), `Name: text`, without placeholders.
 */
export function buildTranscriptText(segments: readonly TranscriptionSegment[]): string {
  const blocks: Array<{ speaker: string | null; text: string }> = []
  let current: { speaker: string | null; text: string } | null = null
  let lastEnd = 0
  for (const segment of segments) {
    const raw = segment.text
    if (raw.trim() === '' || isPlaceholder(raw)) continue
    const otherSpeaker = current !== null && segment.speaker !== current.speaker
    const pause = current !== null && segment.start - lastEnd > 2
    if (!current || otherSpeaker || pause) {
      current = { speaker: segment.speaker, text: raw.trimStart() }
      blocks.push(current)
    } else {
      if (needsSpace(current.text, raw)) current.text += ' '
      current.text += raw
    }
    lastEnd = segment.end
  }
  return blocks
    .map((block) => {
      const speaker = (block.speaker ?? '').trim()
      return speaker ? `${speaker}: ${block.text.trim()}` : block.text.trim()
    })
    .join('\n\n')
}
