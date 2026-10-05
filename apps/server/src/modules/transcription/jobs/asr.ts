import { openAsBlob } from 'node:fs'

import type { TranscriptionLanguage } from '@justcampus/shared'
import { z } from 'zod'

import { bearer, ensureOk, readJson, UpstreamError, upstreamFetch, upstreamUrl } from '../http.js'
import { upstreamLimiter, type ConcurrencyLimiter } from './limiter.js'
import { withRetry } from './upstream.js'

/**
 * Speech recognition through an OpenAI-compatible `POST /audio/transcriptions` (the HRZ gateway
 * with `jlu/whisper-1`, or Speaches workers), with kiChat's fields: Whisper's `verbose_json` and
 * word timing where the server gives it. Times are relative to the audio sent; the merge adds
 * each chunk's offset.
 */

const numberOrNull = z.number().finite().nullable().optional().catch(null)
/** Some servers (the HRZ gateway) send numbers as strings, e.g. `"duration": "8.26"`. */
const numeric = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() !== '' ? Number(value) : value),
  z.number().finite()
)

const verboseSegmentSchema = z.object({
  id: z.number().optional().catch(undefined),
  seek: z.number().nullable().optional().catch(null),
  start: numeric,
  end: numeric,
  text: z.string(),
  tokens: z.array(z.number()).optional().catch(undefined),
  temperature: numberOrNull,
  avg_logprob: numberOrNull,
  compression_ratio: numberOrNull,
  no_speech_prob: numberOrNull
})

const verboseWordSchema = z.object({
  word: z.string(),
  start: numeric,
  end: numeric,
  probability: numberOrNull
})

/** `null` lists count as none: the HRZ gateway answers `"words": null` without word timing. */
const verboseJsonSchema = z.object({
  text: z
    .string()
    .nullable()
    .optional()
    .transform((value) => value ?? ''),
  language: z.string().nullable().optional().catch(null),
  duration: numeric.nullable().optional().catch(null),
  segments: z
    .array(verboseSegmentSchema)
    .nullable()
    .optional()
    .transform((value) => value ?? []),
  words: z
    .array(verboseWordSchema)
    .nullable()
    .optional()
    .transform((value) => value ?? [])
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
  timeoutMs: number
  signal?: AbortSignal
}

/**
 * kiChat's request fields: `model`, `language` unless `auto` (no unsupported literal, section 5),
 * `response_format=verbose_json`, `timestamp_granularities[]=word`, and the WAV as `file`.
 */
export function transcriptionForm(
  file: Blob,
  request: Pick<AsrRequest, 'model' | 'language'>
): FormData {
  const form = new FormData()
  form.set('model', request.model)
  if (request.language !== 'auto') form.set('language', request.language)
  form.set('response_format', 'verbose_json')
  form.append('timestamp_granularities[]', 'word')
  form.set('file', file, 'audio.wav')
  return form
}

/** Recognises one WAV file, streamed from disk; one attempt, without a permit. */
export async function transcribeFile(
  path: string,
  chunkDuration: number | null,
  request: AsrRequest
): Promise<AsrResult> {
  const form = transcriptionForm(await openAsBlob(path, { type: 'audio/wav' }), request)
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

/** One chunk file to recognise. */
export interface AsrChunk {
  path: string
  duration: number | null
}

export interface ParallelAsrRequest extends Omit<AsrRequest, 'baseUrl'> {
  /** The workers, used in turn (kiChat's comma-separated `base_url`). */
  baseUrls: readonly string[]
  /** Requests in flight at most (`asrConcurrency`). */
  limit: number
  limiter?: ConcurrencyLimiter
  retryTimes?: number
  retryDelayMs?: number
  /** After each wave, with the chunks done so far. */
  onWave?: (done: number) => Promise<void> | void
  /** The recognition of one chunk, before the next wave starts (e.g. to cache it). */
  onResult?: (index: number, result: AsrResult) => Promise<void> | void
}

/**
 * kiChat's `transcribeAudioParallel`: the chunks go out in waves as large as the permits the
 * shared budget gives (at least one; with none after the wait, as large as `limit`), so one big
 * job never floods the servers and parallel jobs share them. Workers take the chunks round-robin
 * across waves. Each request is retried for transient failures (`withRetry`); one that still
 * fails fails the whole recognition once its wave is done. Results keep the chunks' order.
 */
export async function transcribeChunksParallel(
  chunks: readonly AsrChunk[],
  request: ParallelAsrRequest
): Promise<AsrResult[]> {
  const urls = request.baseUrls.map((url) => url.trim()).filter(Boolean)
  if (urls.length === 0) throw new Error('No speech worker is set up')
  const limiter = request.limiter ?? upstreamLimiter
  const limit = Math.max(1, request.limit)
  const results = new Array<AsrResult>(chunks.length)
  const pending = chunks.map((_, index) => index)
  let worker = 0
  let done = 0
  while (pending.length > 0) {
    const permits = await limiter.acquire(Math.min(limit, pending.length), {
      label: 'transcriptions (parallel)',
      signal: request.signal
    })
    const size =
      permits.count > 0 ? Math.min(permits.count, pending.length) : Math.min(limit, pending.length)
    const wave = pending.splice(0, size)
    let settled: PromiseSettledResult<AsrResult>[]
    try {
      settled = await Promise.allSettled(
        wave.map((index) => {
          const baseUrl = urls[worker++ % urls.length]!
          const chunk = chunks[index]!
          return withRetry(
            () => transcribeFile(chunk.path, chunk.duration, { ...request, baseUrl }),
            {
              times: request.retryTimes,
              delayMs: request.retryDelayMs,
              signal: request.signal
            }
          )
        })
      )
    } finally {
      permits.release()
    }
    for (const [position, outcome] of settled.entries()) {
      if (outcome.status === 'rejected') throw outcome.reason
      results[wave[position]!] = outcome.value
      await request.onResult?.(wave[position]!, outcome.value)
    }
    done += wave.length
    await request.onWave?.(done)
  }
  return results
}
