import type { TranscriptionSegment } from '@justcampus/shared'

import {
  complete,
  parseJsonObject,
  stripModelFormatting,
  type ChatTarget
} from '../summaries/chat.js'
import { CORRECTION_SYSTEM_PROMPT, correctionPrompt } from '../jobs/correction.js'
import { redactedText, UNKNOWN_SPEAKER } from '../transcripts/text.js'

/**
 * AI speaker optimisation with kiChat's prompt (`AsyncTranscriptionService::
 * optimizeTranscriptSpeakers`): the chat model reads `Segment [X] (Name): text` lines and answers
 * a JSON array of `{original_index, text, speaker}`, splitting a segment where the speaker changes
 * within it and correcting misheard words. The route (T-36) takes only a speaker per segment, the
 * one of most of its text: the client keeps text, timing and redactions and maps the answer by
 * segment id. kiChat's full restructuring after recognition (splits, corrected text, merged
 * neighbours) is the job's LLM correction, `jobs/correction.ts`, with the same prompt.
 *
 * Campus additions: the model reads redacted text; names it invents are ignored; long transcripts
 * go in batches.
 */

/** Segments one request carries; longer transcripts take several. */
export const OPTIMIZATION_BATCH = 150

/** The batch as kiChat lists it, `Segment [index] (Name): text`, redactions applied. */
export function formatSegments(
  segments: readonly Pick<TranscriptionSegment, 'speaker' | 'text' | 'redactions'>[]
): string {
  return segments
    .map(
      (segment, index) =>
        `Segment [${index}] (${segment.speaker?.trim() || UNKNOWN_SPEAKER}): ${redactedText(segment)}\n`
    )
    .join('')
}

/** One entry of the model's answer. */
export interface Correction {
  originalIndex: number
  text: string
  speaker: string
}

/** The JSON array of an answer: bare, inside a fence or prose, or the first list of an object. */
function answerList(content: string): unknown[] | null {
  const cleaned = stripModelFormatting(content)
  const candidates = [cleaned]
  const start = cleaned.indexOf('[')
  const end = cleaned.lastIndexOf(']')
  if (start >= 0 && end > start) candidates.push(cleaned.slice(start, end + 1))
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate)
      if (Array.isArray(value)) return value
    } catch {
      // Try the next representation.
    }
  }
  const object = parseJsonObject(content)
  const list = object && Object.values(object).find(Array.isArray)
  return list ?? null
}

/**
 * The entries of the model's answer, leniently: `original_index` as number or numeric string,
 * `speaker` required, a missing `text` empty. Anything else is dropped.
 */
export function parseCorrections(content: string): Correction[] {
  const corrections: Correction[] = []
  for (const entry of answerList(content) ?? []) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const raw = record.original_index ?? record.originalIndex
    const index = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) continue
    if (typeof record.speaker !== 'string' || !record.speaker.trim()) continue
    corrections.push({
      originalIndex: index,
      text: typeof record.text === 'string' ? record.text : '',
      speaker: record.speaker.trim()
    })
  }
  return corrections
}

/** The speaker names of the segments in order of appearance. */
export function knownSpeakers(
  segments: readonly Pick<TranscriptionSegment, 'speaker'>[]
): string[] {
  const names = new Set<string>()
  for (const segment of segments) if (segment.speaker) names.add(segment.speaker)
  return [...names]
}

/**
 * A name of the model's answer as one of `speakers` (in any case), `null` for kiChat's
 * `Unbekannt`, `undefined` for a name it made up.
 */
function resolveSpeaker(name: string, speakers: readonly string[]): string | null | undefined {
  const lower = name.trim().toLowerCase()
  if (lower === UNKNOWN_SPEAKER.toLowerCase()) return null
  return speakers.find((speaker) => speaker.toLowerCase() === lower)
}

/** The entries of each index of the batch that name a known speaker. */
function groupCorrections(
  corrections: readonly Correction[],
  batchLength: number,
  speakers: readonly string[]
): Map<number, (Correction & { resolved: string | null })[]> {
  const grouped = new Map<number, (Correction & { resolved: string | null })[]>()
  for (const correction of corrections) {
    if (correction.originalIndex >= batchLength) continue
    const resolved = resolveSpeaker(correction.speaker, speakers)
    if (resolved === undefined) continue
    const list = grouped.get(correction.originalIndex) ?? []
    list.push({ ...correction, resolved })
    grouped.set(correction.originalIndex, list)
  }
  return grouped
}

/** The speaker of most of the text of a segment's entries; the first on a tie. */
function dominantSpeaker(
  entries: readonly { text: string; resolved: string | null }[]
): string | null {
  const lengths = new Map<string | null, number>()
  for (const entry of entries) {
    lengths.set(entry.resolved, (lengths.get(entry.resolved) ?? 0) + entry.text.trim().length)
  }
  let best = entries[0]!.resolved
  for (const [speaker, length] of lengths) if (length > lengths.get(best)!) best = speaker
  return best
}

/** The model's answer did not refer to any segment it was given. */
export class UnusableOptimizationError extends Error {
  constructor() {
    super('The chat model answered without a usable speaker assignment')
    this.name = 'UnusableOptimizationError'
  }
}

/** Asks the model about one batch; its entries, or an `UnusableOptimizationError`. */
async function requestCorrections(
  target: ChatTarget,
  batch: readonly TranscriptionSegment[],
  speakers: readonly string[],
  signal?: AbortSignal
): Promise<Map<number, (Correction & { resolved: string | null })[]>> {
  const content = await complete(
    target,
    [
      { role: 'system', content: CORRECTION_SYSTEM_PROMPT },
      { role: 'user', content: correctionPrompt(formatSegments(batch)) }
    ],
    { signal }
  )
  const grouped = groupCorrections(parseCorrections(content), batch.length, speakers)
  if (grouped.size === 0) throw new UnusableOptimizationError()
  return grouped
}

/** The segments with their speakers replaced where assigned one; nothing else changes. */
export function applyAssignments(
  segments: readonly TranscriptionSegment[],
  assignments: ReadonlyMap<number, string | null>
): TranscriptionSegment[] {
  return segments.map((segment) => {
    const speaker = assignments.get(segment.id)
    return speaker === undefined || speaker === segment.speaker ? segment : { ...segment, speaker }
  })
}

/**
 * Segment id → speaker from the model's entries for a batch: the speaker of most of each
 * segment's text. `Unbekannt` takes no name away.
 */
export function speakerAssignments(
  batch: readonly TranscriptionSegment[],
  grouped: ReadonlyMap<number, readonly { text: string; resolved: string | null }[]>
): Map<number, string | null> {
  const assignments = new Map<number, string | null>()
  batch.forEach((segment, index) => {
    const entries = grouped.get(index)
    if (entries && entries.length > 0) {
      assignments.set(segment.id, dominantSpeaker(entries) ?? segment.speaker)
    }
  })
  return assignments
}

/**
 * The speaker optimisation of the route (T-36): kiChat's request, batch by batch, with only a
 * speaker per segment taken from it. With fewer than two named speakers there is nothing to
 * choose between, and the segments come back unchanged without a request. A batch whose answer
 * refers to none of its segments fails the whole optimisation with an
 * `UnusableOptimizationError`, so the client keeps its segments and reports the error.
 */
export async function optimizeSpeakers(
  target: ChatTarget,
  segments: readonly TranscriptionSegment[],
  signal?: AbortSignal
): Promise<TranscriptionSegment[]> {
  const speakers = knownSpeakers(segments)
  if (speakers.length < 2) return [...segments]
  const assignments = new Map<number, string | null>()
  for (let offset = 0; offset < segments.length; offset += OPTIMIZATION_BATCH) {
    const batch = segments.slice(offset, offset + OPTIMIZATION_BATCH)
    const grouped = await requestCorrections(target, batch, speakers, signal)
    for (const [id, speaker] of speakerAssignments(batch, grouped)) assignments.set(id, speaker)
  }
  return applyAssignments(segments, assignments)
}
