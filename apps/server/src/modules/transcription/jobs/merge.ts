import type { TranscriptionSegment, TranscriptionWord } from '@justcampus/shared'

import type { AsrResult } from './asr.js'

/** One piece of the normalised audio that is recognised on its own. */
export interface ChunkPlan {
  index: number
  /** Seconds into the whole file. */
  start: number
  end: number
}

/** A last piece shorter than this is added to the one before rather than sent alone. */
const MIN_TAIL_SECONDS = 5

/**
 * Cuts `duration` seconds into chunks of `chunkSeconds`, back to back without overlap (kiChat's
 * short file had one chunk with no overlap; Q-06). A very short tail joins the previous chunk.
 */
export function planChunks(duration: number, chunkSeconds: number): ChunkPlan[] {
  if (!(duration > 0)) return [{ index: 0, start: 0, end: 0 }]
  const size = Math.max(1, chunkSeconds)
  const chunks: ChunkPlan[] = []
  for (let start = 0; start < duration; start += size) {
    chunks.push({ index: chunks.length, start, end: Math.min(duration, start + size) })
  }
  const last = chunks.at(-1)!
  if (chunks.length > 1 && last.end - last.start < MIN_TAIL_SECONDS) {
    chunks.pop()
    chunks.at(-1)!.end = duration
  }
  return chunks
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** The recognised text of all chunks as one result, without speakers yet. */
export interface MergedRecognition {
  text: string
  language: string | null
  segments: TranscriptionSegment[]
  words: TranscriptionWord[]
}

/**
 * Puts the chunks' results together in order: every segment and word moves by its chunk's start
 * and stays within its chunk, so timing runs on monotonically over the whole file. Segments are
 * numbered from 1, as kiChat's results are. The language is the one most chunks detected.
 */
export function mergeChunks(
  chunks: ReadonlyArray<{ plan: ChunkPlan; result: AsrResult }>
): MergedRecognition {
  const segments: TranscriptionSegment[] = []
  const words: TranscriptionWord[] = []
  const languages = new Map<string, number>()
  const ordered = [...chunks].sort((a, b) => a.plan.start - b.plan.start)
  for (const { plan, result } of ordered) {
    const length = plan.end - plan.start
    const place = (seconds: number): number =>
      round3(
        plan.start + (length > 0 ? Math.min(Math.max(0, seconds), length) : Math.max(0, seconds))
      )
    if (result.language) languages.set(result.language, (languages.get(result.language) ?? 0) + 1)
    for (const segment of result.segments) {
      const start = place(segment.start)
      segments.push({
        id: segments.length + 1,
        start,
        end: Math.max(start, place(segment.end)),
        text: segment.text,
        speaker: null,
        redactions: [],
        avgLogprob: segment.avgLogprob,
        compressionRatio: segment.compressionRatio,
        noSpeechProb: segment.noSpeechProb,
        temperature: segment.temperature,
        seek: segment.seek,
        ...(segment.tokens ? { tokens: segment.tokens } : {})
      })
    }
    for (const word of result.words) {
      const start = place(word.start)
      words.push({
        start,
        end: Math.max(start, place(word.end)),
        word: word.word,
        probability: word.probability
      })
    }
  }
  let language: string | null = null
  let votes = 0
  for (const [code, count] of languages) {
    if (count > votes) {
      language = code
      votes = count
    }
  }
  return { text: joinText(segments), language, segments, words }
}

/** The plain text of segments, as kiChat's `text`: their texts separated by spaces. */
export function joinText(segments: readonly Pick<TranscriptionSegment, 'text'>[]): string {
  return segments
    .map((segment) => segment.text.trim())
    .filter(Boolean)
    .join(' ')
}
