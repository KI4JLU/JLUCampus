import {
  TRANSCRIPTION_SEGMENT_TEXT_MAX,
  TRANSCRIPTION_SEGMENT_WORDS_MAX,
  transcriptionSegmentsSchema,
  type TranscriptionSegment
} from '@justcampus/shared'

import { complete, stripModelFormatting, type ChatTarget } from '../summaries/chat.js'

/**
 * The optional LLM correction after recognition and speaker mapping (T-09), ported from kiChat's
 * `AsyncTranscriptionService::optimizeTranscriptSpeakers`: the chat model reads the transcript as
 * `Segment [i] (speaker): text`, corrects misheard words and wrong speakers, and may split a
 * segment where the speaker changes. Split parts share their parent's time in proportion to their
 * text; neighbours of one speaker less than 3 s apart are merged again and all segments numbered
 * from 1. A segment the model left out stays as it was.
 *
 * kiChat sends the whole transcript at once; long transcripts here go in batches of whole
 * segments (`correctionBatches`) so a request stays within the model's context.
 */

/** Segments and characters one request carries at most. */
export const BATCH_SEGMENTS = 150
export const BATCH_CHARACTERS = 20_000

/** kiChat's label for a segment without speaker. */
const UNKNOWN = 'Unbekannt'

export const CORRECTION_SYSTEM_PROMPT =
  'Du bist ein präziser Helfer, der Sprecherzuordnungen und Sprecherwechsel in Transkripten logisch korrigiert und ausschließlich valides JSON antwortet.'

/** The transcript as kiChat shows it to the model, one `Segment [i] (speaker): text` per line. */
export function formatTranscript(
  segments: readonly Pick<TranscriptionSegment, 'speaker' | 'text'>[]
): string {
  return segments
    .map(
      (segment, index) => `Segment [${index}] (${segment.speaker ?? UNKNOWN}): ${segment.text}\n`
    )
    .join('')
}

/** kiChat's correction prompt, word for word, around the formatted transcript. */
export function correctionPrompt(formattedTranscript: string): string {
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

/** Splits segments into requests of bounded size, keeping their order. */
export function correctionBatches<T extends Pick<TranscriptionSegment, 'text'>>(
  segments: readonly T[]
): T[][] {
  const batches: T[][] = []
  let batch: T[] = []
  let characters = 0
  for (const segment of segments) {
    if (
      batch.length > 0 &&
      (batch.length >= BATCH_SEGMENTS || characters + segment.text.length > BATCH_CHARACTERS)
    ) {
      batches.push(batch)
      batch = []
      characters = 0
    }
    batch.push(segment)
    characters += segment.text.length
  }
  if (batch.length > 0) batches.push(batch)
  return batches
}

/**
 * The model's answer was no JSON array (kiChat: „keine gültige JSON-Antwort“), or its corrections
 * gave segments a transcript cannot hold.
 */
export class InvalidCorrectionError extends Error {
  constructor(message = 'Die KI hat keine gültige JSON-Antwort geliefert.') {
    super(message)
    this.name = 'InvalidCorrectionError'
  }
}

export interface Correction {
  originalIndex: number
  text: string
  speaker: string
}

/**
 * The corrections of an answer: a JSON array, also inside a code fence or after thinking.
 * Entries without `original_index`, `text` and `speaker` are left out, as kiChat leaves them.
 */
export function parseCorrections(content: string): Correction[] {
  let value: unknown
  try {
    value = JSON.parse(stripModelFormatting(content))
  } catch {
    throw new InvalidCorrectionError()
  }
  if (!Array.isArray(value)) throw new InvalidCorrectionError()
  const corrections: Correction[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const index = Number(record.original_index)
    if (record.original_index === undefined || record.original_index === null) continue
    if (!Number.isInteger(index) || typeof record.text !== 'string') continue
    if (typeof record.speaker !== 'string') continue
    corrections.push({ originalIndex: index, text: record.text, speaker: record.speaker })
  }
  return corrections
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Applies a batch's corrections as kiChat does: per segment its parts in order, the time shared by
 * their text's byte length, speaker prefixes such as `Stimme 1:` removed from the text. A part may
 * only name a speaker of the transcript (others keep the segment's own); `Unbekannt` is none.
 */
export function applyCorrections(
  segments: readonly TranscriptionSegment[],
  corrections: readonly Correction[],
  speakers: readonly string[]
): TranscriptionSegment[] {
  const grouped = new Map<number, Correction[]>()
  for (const correction of corrections) {
    const list = grouped.get(correction.originalIndex) ?? []
    list.push(correction)
    grouped.set(correction.originalIndex, list)
  }
  const names = new Set(speakers)
  const prefixes = [
    ...new Set([...speakers, ...corrections.map((correction) => correction.speaker)])
  ]
    .filter(Boolean)
    .map(escapeRegExp)
  prefixes.push('Sprecher\\s+\\d+', 'Stimme\\s+\\d+', UNKNOWN)
  const leading = new RegExp(`^(${prefixes.join('|')}):\\s*`, 'iu')
  const inline = new RegExp(`\\s+(${prefixes.join('|')}):\\s*`, 'giu')

  const result: TranscriptionSegment[] = []
  segments.forEach((parent, index) => {
    const parts = grouped.get(index)
    if (!parts || parts.length === 0) {
      result.push(parent)
      return
    }
    const total = parts.reduce((sum, part) => sum + Buffer.byteLength(part.text), 0)
    if (total <= 0) {
      result.push(parent)
      return
    }
    const duration = parent.end - parent.start
    let start = parent.start
    parts.forEach((part, position) => {
      let end = start + duration * (Buffer.byteLength(part.text) / total)
      if (position === parts.length - 1) end = parent.end
      const speaker =
        part.speaker === UNKNOWN ? null : names.has(part.speaker) ? part.speaker : parent.speaker
      const { words, ...rest } = parent
      const from = start
      result.push({
        ...rest,
        start: round2(from),
        end: round2(Math.max(from, end)),
        text: part.text.replace(leading, '').replace(inline, ' ').trim(),
        speaker,
        redactions: [],
        ...(words
          ? {
              words: words.filter((word) => {
                const middle = (word.start + word.end) / 2
                return middle >= from && middle <= end
              })
            }
          : {})
      })
      start = end
    })
  })
  return result
}

/**
 * kiChat's last step: one speaker's neighbours less than 3 s apart become one segment. Campus: a
 * merge stops where the segment would outgrow what a segment holds (`TRANSCRIPTION_SEGMENT_TEXT_MAX`
 * characters, `TRANSCRIPTION_SEGMENT_WORDS_MAX` words), as the speaker mapping's merge does, so a
 * long monologue stays a valid transcript.
 */
export function mergeSpeakerRuns(
  segments: readonly TranscriptionSegment[]
): TranscriptionSegment[] {
  const merged: TranscriptionSegment[] = []
  for (const segment of segments) {
    const current = merged[merged.length - 1]
    if (current && segment.speaker === current.speaker && segment.start - current.end < 3) {
      const text = `${current.text.trim()} ${segment.text.trim()}`
      const words = segment.words ? [...(current.words ?? []), ...segment.words] : current.words
      if (
        text.length <= TRANSCRIPTION_SEGMENT_TEXT_MAX &&
        (words?.length ?? 0) <= TRANSCRIPTION_SEGMENT_WORDS_MAX
      ) {
        merged[merged.length - 1] = {
          ...current,
          end: segment.end,
          text,
          redactions: [],
          ...(segment.words ? { words } : {})
        }
        continue
      }
    }
    merged.push(segment)
  }
  return merged.map((segment, index) => ({ ...segment, id: index + 1 }))
}

/** The speaker names of the segments, in order of appearance. */
function speakerNames(segments: readonly TranscriptionSegment[]): string[] {
  return [...new Set(segments.map((segment) => segment.speaker).filter((name) => name !== null))]
}

/** One batch through the model; its answer applied. */
export async function correctBatch(
  segments: readonly TranscriptionSegment[],
  target: ChatTarget,
  signal?: AbortSignal
): Promise<TranscriptionSegment[]> {
  const content = await complete(
    target,
    [
      { role: 'system', content: CORRECTION_SYSTEM_PROMPT },
      { role: 'user', content: correctionPrompt(formatTranscript(segments)) }
    ],
    { signal }
  )
  return applyCorrections(segments, parseCorrections(content), speakerNames(segments))
}

/**
 * Corrects all segments batch by batch, reporting each batch done, then merges and numbers them
 * as kiChat does. `run` wraps every request, so the caller can retry transient failures. An
 * answer that is no JSON array, or corrections that give segments a transcript cannot hold (a
 * part beyond the text limit, too many splits), throw `InvalidCorrectionError`, so the caller
 * keeps the uncorrected text.
 */
export async function correctSegments(
  segments: readonly TranscriptionSegment[],
  target: ChatTarget,
  options: {
    signal?: AbortSignal
    run?: <T>(call: () => Promise<T>) => Promise<T>
    onBatch?: (done: number, total: number) => Promise<void> | void
  } = {}
): Promise<TranscriptionSegment[]> {
  const run = options.run ?? (<T>(call: () => Promise<T>) => call())
  const batches = correctionBatches(segments)
  const corrected: TranscriptionSegment[] = []
  for (const [index, batch] of batches.entries()) {
    await options.onBatch?.(index, batches.length)
    corrected.push(...(await run(() => correctBatch(batch, target, options.signal))))
  }
  const merged = mergeSpeakerRuns(corrected)
  if (!transcriptionSegmentsSchema.safeParse(merged).success) {
    throw new InvalidCorrectionError('Die KI-Korrektur ergab ungültige Abschnitte.')
  }
  return merged
}
