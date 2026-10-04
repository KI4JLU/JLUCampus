import type { TranscriptionSegment } from '@justcampus/shared'
import { redactedText } from '../export/format'
import { isLocalTranscriptId } from '../history/local-store'
import type { TranscriptDocument } from '../workspace'

/**
 * What a summary or an AI section preview is made from (T-49, T-53). A saved transcript is named
 * and the server reads it; one only this browser has (`local-…`, a save that failed) is sent as
 * its text with the redactions applied, as kiChat sends `transcript_text` for unsaved input.
 */

/** What the server calls a speaker it does not know; the same in the text sent. */
const UNKNOWN_SPEAKER = 'Unbekannt'

/** A new turn starts with another speaker or after this much silence (kiChat: 10 s). */
const TURN_GAP_SECONDS = 10

/**
 * `Name: text` lines, one per speaker turn, redactions replaced by `[AUSGEBLENDET]`: the text the
 * server makes of a saved transcript (`speakerText` in its `transcripts/text.ts`), so a local
 * transcript reads to the model as a saved one does.
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

/** The request fields naming what a summary or preview is made of. */
export interface SummarySource {
  /** A saved transcript; `null` for a local one. */
  transcriptId: string | null
  /** A local transcript's text, redactions applied; `null` for a saved one. */
  transcriptText: string | null
}

export function summarySource(document: TranscriptDocument): SummarySource {
  return isLocalTranscriptId(document.transcript.id)
    ? { transcriptId: null, transcriptText: speakerText(document.segments) }
    : { transcriptId: document.transcript.id, transcriptText: null }
}

/**
 * A short fingerprint of a text (cyrb53: 53 bits, with its length), for keys that must change
 * with the text without holding all of it.
 */
export function textFingerprint(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    h1 = Math.imul(h1 ^ code, 2654435761)
    h2 = Math.imul(h2 ^ code, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  const hash = 4294967296 * (2097151 & h2) + (h1 >>> 0)
  return `${text.length}:${hash.toString(36)}`
}
