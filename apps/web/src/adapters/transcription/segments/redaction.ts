import {
  TRANSCRIPTION_REDACTED_TEXT,
  type TranscriptionRedaction,
  type TranscriptionSegment
} from '@justcampus/shared'
import type { SpeakerBlock } from './blocks'
import { normalizeSelection, type SelectionBounds } from './edit'
import { isPlaceholder, joinTexts } from './text'

/**
 * Redaction after kiChat's `redactSelectedText` and `Utils` (T-33): character ranges per segment,
 * trimmed of blanks and merged when they touch or overlap. The text itself stays stored; views
 * conceal the ranges and text exports put `[AUSGEBLENDET]` in their place.
 */

/** Longest redacted text the correction panel shows in full; longer ones are cut to 57 + `...`. */
export const REDACTION_LIST_MAX = 60
const REDACTION_LIST_CUT = 57

/** Sorts ranges and merges those that touch or overlap. */
export function mergeRedactions(
  redactions: readonly TranscriptionRedaction[]
): TranscriptionRedaction[] {
  const sorted = [...redactions].sort((a, b) => a.start - b.start)
  const merged: TranscriptionRedaction[] = []
  for (const range of sorted) {
    const last = merged[merged.length - 1]
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end)
    else merged.push({ ...range })
  }
  return merged
}

/**
 * Redacts the selected text: in each selected segment the selected part without leading and
 * trailing blanks. `null` when the selection holds nothing to redact.
 */
export function redactSelection(
  segments: readonly TranscriptionSegment[],
  bounds: SelectionBounds | null
): TranscriptionSegment[] | null {
  const selection = normalizeSelection(segments, bounds)
  if (!selection) return null
  const result = [...segments]
  let changed = false
  for (let index = selection.start.segment; index <= selection.end.segment; index++) {
    const segment = result[index]!
    let start = index === selection.start.segment ? selection.start.offset : 0
    let end = index === selection.end.segment ? selection.end.offset : segment.text.length
    while (start < end && /\s/.test(segment.text[start]!)) start++
    while (end > start && /\s/.test(segment.text[end - 1]!)) end--
    if (start >= end) continue
    const redactions = mergeRedactions([...segment.redactions, { start, end }])
    result[index] = { ...segment, redactions }
    changed = true
  }
  return changed ? result : null
}

/** Removes one redaction of a segment. */
export function removeRedaction(
  segments: readonly TranscriptionSegment[],
  segmentIndex: number,
  redactionIndex: number
): TranscriptionSegment[] | null {
  const segment = segments[segmentIndex]
  if (!segment?.redactions[redactionIndex]) return null
  const result = [...segments]
  result[segmentIndex] = {
    ...segment,
    redactions: segment.redactions.filter((_, index) => index !== redactionIndex)
  }
  return result
}

/** Removes every redaction; `null` when there is none. The text is unchanged (T-33). */
export function clearRedactions(
  segments: readonly TranscriptionSegment[]
): TranscriptionSegment[] | null {
  if (!segments.some((segment) => segment.redactions.length > 0)) return null
  return segments.map((segment) =>
    segment.redactions.length > 0 ? { ...segment, redactions: [] } : segment
  )
}

export interface RedactionEntry {
  segment: number
  redaction: number
  /** The segment's speaker; `null` shows as unknown. */
  speaker: string | null
  text: string
  /** `text`, cut to 57 characters plus `...` when longer than 60. */
  display: string
}

/** Cuts a redacted text for the list as kiChat does. */
export function truncateRedaction(text: string): string {
  return text.length > REDACTION_LIST_MAX ? `${text.slice(0, REDACTION_LIST_CUT)}...` : text
}

/** Every redaction in transcript order, for the correction panel's list. */
export function listRedactions(segments: readonly TranscriptionSegment[]): RedactionEntry[] {
  const entries: RedactionEntry[] = []
  segments.forEach((segment, segmentIndex) => {
    segment.redactions.forEach((range, redactionIndex) => {
      const text = segment.text.slice(range.start, range.end)
      entries.push({
        segment: segmentIndex,
        redaction: redactionIndex,
        speaker: segment.speaker,
        text,
        display: truncateRedaction(text)
      })
    })
  })
  return entries
}

/** A stretch of a segment's text: shown as it is, or concealed. */
export interface TextPiece {
  redacted: boolean
  /** Offsets into the segment's text, `end` exclusive. */
  start: number
  end: number
  text: string
}

/** Cuts a text into plain and redacted pieces, in order; ranges outside the text are clipped. */
export function textPieces(
  text: string,
  redactions: readonly TranscriptionRedaction[]
): TextPiece[] {
  const pieces: TextPiece[] = []
  let position = 0
  for (const range of mergeRedactions(redactions)) {
    const start = Math.max(position, Math.min(range.start, text.length))
    const end = Math.min(range.end, text.length)
    if (end <= start) continue
    if (start > position) {
      pieces.push({
        redacted: false,
        start: position,
        end: start,
        text: text.slice(position, start)
      })
    }
    pieces.push({ redacted: true, start, end, text: text.slice(start, end) })
    position = end
  }
  if (position < text.length || pieces.length === 0) {
    pieces.push({ redacted: false, start: position, end: text.length, text: text.slice(position) })
  }
  return pieces
}

/** The text with every redacted range replaced, e.g. by `[AUSGEBLENDET]` for copies and exports. */
export function redactedText(
  text: string,
  redactions: readonly TranscriptionRedaction[],
  replacement: string = TRANSCRIPTION_REDACTED_TEXT
): string {
  return textPieces(text, redactions)
    .map((piece) => (piece.redacted ? replacement : piece.text))
    .join('')
}

/**
 * A block's text as its copy button copies it (T-32): redacted ranges as `[AUSGEBLENDET]`, a
 * placeholder as the hint shown in its place.
 */
export function blockCopyText(
  segments: readonly TranscriptionSegment[],
  block: SpeakerBlock,
  placeholder: string
): string {
  const texts = block.segmentIndices.map((index) => {
    const segment = segments[index]
    if (!segment) return ''
    return isPlaceholder(segment.text)
      ? placeholder
      : redactedText(segment.text, segment.redactions)
  })
  return joinTexts(texts).trim()
}
