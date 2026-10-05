import type { TranscriptionSegment } from '@justcampus/shared'

import {
  complete,
  parseJsonObject,
  stripModelFormatting,
  type ChatTarget
} from '../summaries/chat.js'
import { redactedText, UNKNOWN_SPEAKER } from '../transcripts/text.js'

/**
 * AI speaker optimisation with kiChat's prompt (`AsyncTranscriptionService::
 * optimizeTranscriptSpeakers`): the chat model reads `Segment [X] (Name): text` lines and answers
 * a JSON array of `{original_index, text, speaker}`, splitting a segment where the speaker changes
 * within it and correcting misheard words.
 *
 * Two ways to use the answer:
 * - `optimizeSpeakers` (the route, T-36) takes only a speaker per segment, the one of most of its
 *   text: the client keeps text, timing and redactions and maps the answer by segment id.
 * - `optimizeTranscriptSpeakers` restructures the segments as kiChat does after recognition:
 *   splits with interpolated times, corrected text, same-speaker neighbours merged.
 *
 * Campus additions: the model reads redacted text and never gets to change a redacted segment's
 * text; names it invents are ignored; long transcripts go in batches.
 */

/** Segments one request carries; longer transcripts take several. */
export const OPTIMIZATION_BATCH = 150

/** Same-speaker neighbours closer than this are merged (kiChat: 3 s). */
const MERGE_GAP_SECONDS = 3

/** kiChat's system message. */
export const OPTIMIZATION_SYSTEM_PROMPT =
  'Du bist ein präziser Helfer, der Sprecherzuordnungen und Sprecherwechsel in Transkripten logisch korrigiert und ausschließlich valides JSON antwortet.'

/** kiChat's user message around the formatted transcript. */
export function buildOptimizationPrompt(formattedTranscript: string): string {
  return (
    'Du bist ein Experte für Gesprächsprotokolle und Transkriptionen.\n' +
    'Hier ist ein Transkript, bei dem die akustische Sprecherzuordnung (Diarization) fehlerhaft sein kann und manche Wörter falsch transkribiert wurden.\n' +
    'Deine Aufgabe ist es, das Transkript semantisch zu analysieren, Fehler in der Sprecherzuordnung zu korrigieren, Falschschreibungen/Hörfehler von Wörtern auszubessern und das Ergebnis als JSON zurückzugeben.\n\n' +
    'HÄUFIGE DIARIZATION-FEHLER (die du korrigieren musst):\n' +
    "1. Kurze Halbsätze, Satzanfänge (z. B. 'Oh, danke', 'Guten Morgen') oder persönliche Anreden/Namen wurden dem vorherigen/nächsten Sprecher zugeordnet, obwohl sie semantisch zu einem anderen gehören.\n" +
    "2. Kurze Reaktionen, Einwürfe oder Antworten (wie 'Schön!', 'Na gut.', 'Na klar.', 'Ja.', 'Nein.') am Ende eines langen Redebeitrags wurden fälschlicherweise dem vorherigen Sprecher zugeordnet, obwohl sie dem Gesprächspartner gehören. Analysiere das Frage-Antwort-Muster und den Dialogkontext logisch und korrigiere den Sprecher für solche Einwürfe.\n" +
    "3. Kurze Einwürfe oder Reaktionen (z. B. 'Oh Mann!', 'Ach so!', 'Echt?', 'Stimmt.') mitten in einem Segment können einem anderen Sprecher gehören. Wenn ein Sprecher einen Satz beendet, der Gesprächspartner kurz reagiert und der erste Sprecher danach fortfährt, teile das Segment auf und ordne den Einwurf dem Gesprächspartner zu.\n\n" +
    'KORREKTUR VON HÖRFEHLERN / TRANSKRIPTIONSFEHLERN:\n' +
    "- Manchmal erkennt die Spracherkennung (Whisper) bestimmte Wörter, Namen, Eigennamen oder Fachbegriffe nicht korrekt oder unvollständig (z. B. Halluzinationen, akustische Missverständnisse wie 'katamau' statt 'Kater Mau' oder 'projektfönix' statt 'Projekt Phoenix').\n" +
    "- Analysiere den Kontext des gesamten Transkripts: Wenn ein Begriff an einer Stelle falsch/akustisch entstellt transkribiert wurde, aber an einer anderen Stelle oder im Kontext korrekt vorkommt (z. B. 'Kater Mau' oder 'Projekt Phoenix'), korrigiere das fehlerhafte Wort an allen betroffenen Stellen im Text, damit es konsistent und korrekt ist.\n\n" +
    'REGELN FÜR DIE RÜCKGABE:\n' +
    '- Ändere den Text nur zur Behebung von eindeutigen Hörfehlern/Falschschreibungen basierend auf dem Gesprächskontext. Füge keine eigenen Sätze hinzu und lasse keine inhaltlichen Teile weg.\n' +
    "- Du darfst Segmente in kleinere Untersegmente aufteilen (splitten), wenn innerhalb eines Segments der Sprecher wechselt. Jedes Untersegment erhält denselben 'original_index'.\n" +
    "- WICHTIG: Jedes Eingabesegment MUSS exakt über sein original_index referenziert werden. Der Index entspricht der Zahl X in 'Segment [X]'. Du darfst unter keinen Umständen Indizes neu nummerieren, verschieben oder auslassen! Für jedes Eingabesegment X muss es mindestens ein Objekt mit 'original_index': X geben.\n" +
    '- Verwende ausschließlich die im bereitgestellten Transkript vorkommenden Sprechernamen. Erfinde keine neuen Namen.\n' +
    "- Das JSON-Feld 'text' darf unter keinen Umständen Bezeichner wie 'Segment [X]' oder Sprechernamen am Anfang enthalten.\n\n" +
    'Hier ist das Transkript:\n' +
    formattedTranscript +
    '\n' +
    'Gib das Ergebnis ausschließlich als JSON-Array von Objekten zurück, wobei jedes Objekt folgende Felder hat:\n' +
    '- "original_index": Die Zahl X des Originalsegments "Segment [X]" aus der Eingabe (MUSS exakt übereinstimmen, KEINE Neunummerierung!).\n' +
    '- "text": Der bereinigte und korrigierte Text dieses (Unter-)Segments.\n' +
    '- "speaker": Der korrigierte Sprechername (muss exakt einer der Sprechernamen aus dem obigen Transkript sein!).\n\n' +
    'Beispiel-Antwort:\n' +
    '[\n' +
    '  {"original_index": 0, "text": "Guten Morgen allerseits. Wir wollen heute über das neue Projekt Phoenix sprechen.", "speaker": "Stimme 1"},\n' +
    '  {"original_index": 0, "text": "Guten Morgen, Herr Schmidt.", "speaker": "Stimme 2"},\n' +
    '  {"original_index": 1, "text": "Ich habe mir die Zahlen angeschaut.", "speaker": "Stimme 2"},\n' +
    '  {"original_index": 1, "text": "Oh Mann!", "speaker": "Stimme 1"},\n' +
    '  {"original_index": 1, "text": "Aber wir müssen noch etwas warten.", "speaker": "Stimme 2"},\n' +
    '  {"original_index": 2, "text": "Das passt so. Auf jeden Fall läuft das Projekt Phoenix stabil.", "speaker": "Stimme 1"}\n' +
    ']\n' +
    'Antworte NUR mit dem validen JSON-Array. Keine Einleitung, keine Erklärung, kein Markdown-Fencing (kein ```json).'
  )
}

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
      { role: 'system', content: OPTIMIZATION_SYSTEM_PROMPT },
      { role: 'user', content: buildOptimizationPrompt(formatSegments(batch)) }
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

/** A speaker label the model put in front of the text (`Anna:`, `Sprecher 2:`), kiChat's list. */
function speakerPrefixes(speakers: readonly string[]): { leading: RegExp; inline: RegExp } {
  const escaped = speakers.map((speaker) => speaker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const names = [...escaped, 'Sprecher\\s+\\d+', 'Stimme\\s+\\d+', UNKNOWN_SPEAKER].join('|')
  return {
    leading: new RegExp(`^(${names}):\\s*`, 'iu'),
    inline: new RegExp(`\\s+(${names}):\\s*`, 'giu')
  }
}

/** The segment without its decoder `tokens`, which no longer match a changed text. */
function withoutTokens(segment: TranscriptionSegment): TranscriptionSegment {
  const copy = { ...segment }
  delete copy.tokens
  return copy
}

/** Two decimals, as kiChat rounds interpolated times. */
function round(seconds: number): number {
  return Math.round(seconds * 100) / 100
}

/**
 * kiChat's restructuring of one batch: each segment's entries become sub-segments in their order,
 * the segment's time split by text length, words assigned by their midpoint, speaker labels
 * removed from the text, `Unbekannt` taking no name away. The first keeps the segment's id, the
 * others take `nextId()`. A segment
 * without entries stays; a redacted one keeps its text and takes the dominant speaker; a corrected
 * text less than half or more than twice as long as the original (from 20 characters) is not
 * trusted, the segment keeps its text and takes the dominant speaker.
 */
export function restructureBatch(
  batch: readonly TranscriptionSegment[],
  grouped: ReadonlyMap<number, readonly { text: string; resolved: string | null }[]>,
  speakers: readonly string[],
  nextId: () => number
): TranscriptionSegment[] {
  const prefixes = speakerPrefixes(speakers)
  const clean = (text: string): string =>
    text.replace(prefixes.leading, '').replace(prefixes.inline, ' ').trim()
  return batch.flatMap((parent, index): TranscriptionSegment[] => {
    const entries = (grouped.get(index) ?? [])
      .map((entry) => ({ ...entry, text: clean(entry.text) }))
      .filter((entry) => entry.text)
    if (entries.length === 0) {
      const all = grouped.get(index)
      return all && all.length > 0
        ? [{ ...parent, speaker: dominantSpeaker(all) ?? parent.speaker }]
        : [parent]
    }
    const total = entries.reduce((sum, entry) => sum + entry.text.length, 0)
    const original = parent.text.trim().length
    const ratio = total / Math.max(1, original)
    if (parent.redactions.length > 0 || (original >= 20 && (ratio > 2 || ratio < 0.5))) {
      return [{ ...parent, speaker: dominantSpeaker(entries) ?? parent.speaker }]
    }
    if (entries.length === 1 && entries[0]!.text === parent.text.trim()) {
      return [{ ...parent, speaker: entries[0]!.resolved ?? parent.speaker }]
    }
    const duration = parent.end - parent.start
    let start = parent.start
    return entries.map((entry, position) => {
      const end =
        position === entries.length - 1
          ? parent.end
          : start + duration * (entry.text.length / total)
      const segment: TranscriptionSegment = {
        ...withoutTokens(parent),
        id: position === 0 ? parent.id : nextId(),
        start: round(start),
        end: round(end),
        text: entry.text,
        speaker: entry.resolved ?? parent.speaker,
        redactions: []
      }
      if (parent.words) {
        const from = start
        segment.words = parent.words.filter((word) => {
          const middle = (word.start + word.end) / 2
          return middle >= from && middle <= end
        })
      }
      start = end
      return segment
    })
  })
}

/**
 * kiChat's merge after restructuring: neighbours of one speaker less than three seconds apart
 * become one segment. Redacted segments are not merged, as their ranges belong to their text.
 */
export function mergeSpeakerRuns(
  segments: readonly TranscriptionSegment[]
): TranscriptionSegment[] {
  const merged: TranscriptionSegment[] = []
  for (const segment of segments) {
    const previous = merged.at(-1)
    if (
      previous &&
      previous.speaker === segment.speaker &&
      segment.start - previous.end < MERGE_GAP_SECONDS &&
      previous.redactions.length === 0 &&
      segment.redactions.length === 0
    ) {
      merged[merged.length - 1] = {
        ...withoutTokens(previous),
        end: Math.max(previous.end, segment.end),
        text: `${previous.text.trim()} ${segment.text.trim()}`,
        ...(previous.words || segment.words
          ? { words: [...(previous.words ?? []), ...(segment.words ?? [])] }
          : {})
      }
    } else {
      merged.push(segment)
    }
  }
  return merged
}

/**
 * kiChat's optimisation as it runs after recognition (`llm_correction`): speakers corrected,
 * segments split where the speaker changes, misheard words corrected, same-speaker neighbours
 * merged. New segments take ids after the highest one. A batch whose answer refers to none of its
 * segments fails it with an `UnusableOptimizationError`.
 */
export async function optimizeTranscriptSpeakers(
  target: ChatTarget,
  segments: readonly TranscriptionSegment[],
  signal?: AbortSignal
): Promise<TranscriptionSegment[]> {
  if (segments.length === 0) return []
  const speakers = knownSpeakers(segments)
  let next = Math.max(...segments.map((segment) => segment.id)) + 1
  const nextId = (): number => next++
  const restructured: TranscriptionSegment[] = []
  for (let offset = 0; offset < segments.length; offset += OPTIMIZATION_BATCH) {
    const batch = segments.slice(offset, offset + OPTIMIZATION_BATCH)
    const grouped = await requestCorrections(target, batch, speakers, signal)
    restructured.push(...restructureBatch(batch, grouped, speakers, nextId))
  }
  return mergeSpeakerRuns(restructured)
}
