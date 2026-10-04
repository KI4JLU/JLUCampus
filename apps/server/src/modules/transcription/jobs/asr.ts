import { openAsBlob } from 'node:fs'

import type { TranscriptionLanguage } from '@justcampus/shared'
import { z } from 'zod'

import { bearer, ensureOk, readJson, UpstreamError, upstreamFetch, upstreamUrl } from '../http.js'

/**
 * Speech recognition through an OpenAI-compatible `POST /audio/transcriptions` (Speaches with
 * `jlu/whisper-1` at the JLU), asking for Whisper's `verbose_json` with segments. Times are
 * relative to the audio sent; the merge adds each chunk's offset.
 */

const numberOrNull = z.number().finite().nullable().optional().catch(null)

const verboseSegmentSchema = z.object({
  id: z.number().optional().catch(undefined),
  seek: z.number().nullable().optional().catch(null),
  start: z.number().finite(),
  end: z.number().finite(),
  text: z.string(),
  tokens: z.array(z.number()).optional().catch(undefined),
  temperature: numberOrNull,
  avg_logprob: numberOrNull,
  compression_ratio: numberOrNull,
  no_speech_prob: numberOrNull
})

const verboseWordSchema = z.object({
  word: z.string(),
  start: z.number().finite(),
  end: z.number().finite(),
  probability: numberOrNull
})

const verboseJsonSchema = z.object({
  text: z.string().optional().default(''),
  language: z.string().nullable().optional().catch(null),
  duration: z.number().finite().nullable().optional().catch(null),
  segments: z.array(verboseSegmentSchema).optional().default([]),
  words: z.array(verboseWordSchema).optional().default([])
})

/** One recognised segment, relative to its chunk, with Whisper's decoder fields camelCased. */
export interface AsrSegment {
  start: number
  end: number
  text: string
  seek: number | null
  tokens?: number[]
  temperature: number | null
  avgLogprob: number | null
  compressionRatio: number | null
  noSpeechProb: number | null
}

export interface AsrWord {
  start: number
  end: number
  word: string
  probability: number | null
}

/** What one chunk's recognition gave. */
export interface AsrResult {
  text: string
  language: string | null
  duration: number | null
  segments: AsrSegment[]
  words: AsrWord[]
}

/** OpenAI answers language names (`german`) where others answer codes (`de`). */
const LANGUAGE_CODES: Record<string, string> = {
  arabic: 'ar',
  chinese: 'zh',
  czech: 'cs',
  danish: 'da',
  dutch: 'nl',
  english: 'en',
  finnish: 'fi',
  french: 'fr',
  german: 'de',
  greek: 'el',
  hungarian: 'hu',
  italian: 'it',
  japanese: 'ja',
  korean: 'ko',
  norwegian: 'no',
  persian: 'fa',
  polish: 'pl',
  portuguese: 'pt',
  romanian: 'ro',
  russian: 'ru',
  spanish: 'es',
  swedish: 'sv',
  turkish: 'tr',
  ukrainian: 'uk'
}

/** A detected language as a short code, e.g. `german` or `de-DE` → `de`. */
export function normalizeLanguage(value: string | null | undefined): string | null {
  const language = value?.trim().toLowerCase()
  if (!language) return null
  if (LANGUAGE_CODES[language]) return LANGUAGE_CODES[language]
  const code = /^([a-z]{2,3})(?:[-_][a-z0-9]+)?$/.exec(language)
  return code ? code[1]! : language.slice(0, 16)
}

/**
 * Whisper's `verbose_json` in the module's shape: segment text trimmed, empty segments dropped, a
 * segment-less answer turned into one segment over the whole chunk.
 */
export function parseVerboseJson(body: unknown, chunkDuration: number | null): AsrResult {
  const parsed = verboseJsonSchema.parse(body)
  let segments: AsrSegment[] = parsed.segments
    .map((segment) => ({
      start: Math.max(0, segment.start),
      end: Math.max(segment.start, segment.end),
      text: segment.text.trim(),
      seek: segment.seek == null ? null : Math.trunc(segment.seek),
      ...(segment.tokens && segment.tokens.every(Number.isInteger)
        ? { tokens: segment.tokens.slice(0, 5000) }
        : {}),
      temperature: segment.temperature ?? null,
      avgLogprob: segment.avg_logprob ?? null,
      compressionRatio: segment.compression_ratio ?? null,
      noSpeechProb: segment.no_speech_prob ?? null
    }))
    .filter((segment) => segment.text.length > 0)
  const text = parsed.text.trim()
  const duration = parsed.duration ?? chunkDuration
  if (segments.length === 0 && text) {
    segments = [
      {
        start: 0,
        end: duration ?? 0,
        text,
        seek: null,
        temperature: null,
        avgLogprob: null,
        compressionRatio: null,
        noSpeechProb: null
      }
    ]
  }
  return {
    text: text || segments.map((segment) => segment.text).join(' '),
    language: normalizeLanguage(parsed.language),
    duration,
    segments,
    words: parsed.words
      .map((word) => ({
        start: Math.max(0, word.start),
        end: Math.max(word.start, word.end),
        word: word.word.slice(0, 200),
        probability: word.probability ?? null
      }))
      .filter((word) => word.word.trim().length > 0)
  }
}

export interface AsrRequest {
  baseUrl: string
  apiKey: string | null
  model: string
  language: TranscriptionLanguage
  /** Text that came before, so recognition carries on across chunks. */
  prompt?: string
  timeoutMs: number
  signal?: AbortSignal
}

/**
 * Recognises one WAV file. The file is streamed from disk; `auto` sends no language rather than
 * an unsupported literal (section 5).
 */
export async function transcribeFile(
  path: string,
  chunkDuration: number | null,
  request: AsrRequest
): Promise<AsrResult> {
  const form = new FormData()
  form.set('file', await openAsBlob(path, { type: 'audio/wav' }), 'audio.wav')
  form.set('model', request.model)
  form.set('response_format', 'verbose_json')
  form.append('timestamp_granularities[]', 'segment')
  if (request.language !== 'auto') form.set('language', request.language)
  if (request.prompt) form.set('prompt', request.prompt)
  const label = 'Die Spracherkennung'
  const response = await ensureOk(
    await upstreamFetch(upstreamUrl(request.baseUrl, 'audio/transcriptions'), {
      method: 'POST',
      body: form,
      headers: { Accept: 'application/json', ...bearer(request.apiKey) },
      timeoutMs: request.timeoutMs,
      signal: request.signal
    }),
    label
  )
  const body = await readJson(response, z.unknown(), label)
  try {
    return parseVerboseJson(body, chunkDuration)
  } catch {
    throw new UpstreamError(`${label} answered in an unexpected shape`, response.status)
  }
}
