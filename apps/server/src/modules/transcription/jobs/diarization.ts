import { openAsBlob } from 'node:fs'

import type { TranscriptionSpeakerCount } from '@justcampus/shared'
import { z } from 'zod'

import { UpstreamError, upstreamUrl } from '../http.js'
import type { ConcurrencyLimiter } from './limiter.js'
import { postToServer } from './upstream.js'

/**
 * Speaker diarisation in kiChat's Speaches contract (`CustomSpeachesProvider`):
 *
 * - `POST {base}/audio/diarization`, multipart `model`, `num_speakers` (one speaker) or
 *   `min_speakers` (several), `file`, and per known voice `known_speaker_names[i]` and
 *   `known_speaker_references[i]` (a base64 WAV data URI). The answer is
 *   `{ "segments": [{ "start", "end", "speaker" }] }` in seconds; a known voice comes back under
 *   its name.
 * - `POST {base}/audio/speech/timestamps`, multipart `model=silero_vad_v5` and `file`: the speech
 *   regions as `[{ "start", "end" }]` in milliseconds, used to fill gaps in the speaker mapping.
 *
 * Both run on the whole file, so their timeout grows with its length (`diarizationTimeoutMs`).
 */

/** One stretch of speech of one voice, in seconds of the whole file. */
export interface DiarizationTurn {
  start: number
  end: number
  speaker: string
}

/** A speech region the VAD found, in seconds. */
export interface SpeechRegion {
  start: number
  end: number
}

/** A voice the user named, with its sample audio. */
export interface KnownSpeaker {
  name: string
  /** `data:audio/wav;base64,…` */
  reference: string
}

/** kiChat's `transcription.diarization_timeout_*`. */
export const DIARIZATION_TIMEOUT = {
  multiplier: 2,
  bufferSeconds: 120,
  floorSeconds: 600,
  ceilingSeconds: 3600
} as const

/** VAD is far cheaper and optional: its budget stops at 900 s. */
export const VAD_TIMEOUT_CEILING_SECONDS = 900

export const VAD_MODEL = 'silero_vad_v5'

/**
 * `clamp(duration × 2 + 120 s, 600 s, 3600 s)` in milliseconds; the floor while the duration is
 * unknown.
 */
export function diarizationTimeoutMs(duration: number | null | undefined): number {
  const { multiplier, bufferSeconds, floorSeconds, ceilingSeconds } = DIARIZATION_TIMEOUT
  if (duration === null || duration === undefined || !(duration > 0)) return floorSeconds * 1000
  const estimate = Math.ceil(duration * multiplier) + bufferSeconds
  return Math.max(floorSeconds, Math.min(ceilingSeconds, estimate)) * 1000
}

export function vadTimeoutMs(duration: number | null | undefined): number {
  return Math.min(VAD_TIMEOUT_CEILING_SECONDS * 1000, diarizationTimeoutMs(duration))
}

/** The speaker-count hint as kiChat sends it: exactly one, at least two, or none. */
export function speakerHint(
  count: TranscriptionSpeakerCount
): { num_speakers: number } | { min_speakers: number } | null {
  if (count === 'single') return { num_speakers: 1 }
  if (count === 'multi') return { min_speakers: 2 }
  return null
}

export interface DiarizationOptions {
  model: string
  speakerCount: TranscriptionSpeakerCount
  knownSpeakers?: readonly KnownSpeaker[]
}

/** The multipart fields of `POST /audio/diarization`, in kiChat's order. */
export function diarizationForm(file: Blob, options: DiarizationOptions): FormData {
  const form = new FormData()
  form.set('model', options.model)
  const hint = speakerHint(options.speakerCount)
  if (hint && 'num_speakers' in hint) form.set('num_speakers', String(hint.num_speakers))
  else if (hint) form.set('min_speakers', String(hint.min_speakers))
  form.set('file', file, 'audio.wav')
  const known = options.knownSpeakers ?? []
  known.forEach((speaker, index) => form.set(`known_speaker_names[${index}]`, speaker.name))
  known.forEach((speaker, index) =>
    form.set(`known_speaker_references[${index}]`, speaker.reference)
  )
  return form
}

const turnSchema = z.object({
  start: z.number().finite(),
  end: z.number().finite(),
  speaker: z.union([z.string(), z.number()]).transform(String)
})

/**
 * The turns of a diarisation answer, `segments` as kiChat reads it (missing: none). Entries
 * without times or speaker, or ending before they start, are left out.
 */
export function parseDiarization(body: unknown): DiarizationTurn[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('The diarisation answer is no object')
  }
  const segments = (body as { segments?: unknown }).segments
  if (segments === undefined || segments === null) return []
  if (!Array.isArray(segments)) throw new Error('The diarisation segments are no list')
  const turns: DiarizationTurn[] = []
  for (const entry of segments) {
    const parsed = turnSchema.safeParse(entry)
    if (!parsed.success || parsed.data.end <= parsed.data.start) continue
    turns.push(parsed.data)
  }
  return turns
}

/** The VAD's regions in seconds (it answers milliseconds); `[]` for anything else. */
export function parseSpeechTimestamps(body: unknown): SpeechRegion[] {
  if (!Array.isArray(body)) return []
  const regions: SpeechRegion[] = []
  for (const entry of body) {
    if (!entry || typeof entry !== 'object') continue
    const { start, end } = entry as { start?: unknown; end?: unknown }
    const from = Number(start)
    const to = Number(end)
    if (start === undefined || end === undefined || !Number.isFinite(from) || !Number.isFinite(to))
      continue
    regions.push({ start: from / 1000, end: to / 1000 })
  }
  return regions
}

export interface DiarizationTarget {
  /** Up to `/v1`. */
  baseUrl: string
  apiKey: string | null
  limiter?: ConcurrencyLimiter
  signal?: AbortSignal
  /** Overrides `postToServer`'s pause between attempts, for tests. */
  backoffMs?: (attempt: number) => number
}

/**
 * Diarises one WAV file. Throws an `UpstreamError` when the server is unreachable, too slow
 * (`timedOut`) or answers with an error status, as kiChat's `analyzeSpeakers` and
 * `processDiarization` throw; zero voices is no error.
 */
export async function diarizeFile(
  path: string,
  duration: number | null,
  options: DiarizationOptions,
  target: DiarizationTarget
): Promise<DiarizationTurn[]> {
  const form = diarizationForm(await openAsBlob(path, { type: 'audio/wav' }), options)
  const answer = await postToServer(upstreamUrl(target.baseUrl, 'audio/diarization'), form, {
    apiKey: target.apiKey,
    timeoutMs: diarizationTimeoutMs(duration),
    label: 'diarization',
    signal: target.signal,
    limiter: target.limiter,
    backoffMs: target.backoffMs
  })
  const label = 'Der Diarization-Server'
  const secrets = [target.apiKey]
  if (answer.error) {
    throw new UpstreamError(
      `${label} is unreachable: ${answer.error}`,
      null,
      null,
      answer.timedOut,
      secrets
    )
  }
  if (answer.status < 200 || answer.status >= 300) {
    // The whole body: the error masks the key in it before cutting it short.
    throw new UpstreamError(
      `${label} answered with status ${answer.status}`,
      answer.status,
      answer.body || null,
      false,
      secrets
    )
  }
  // Decided on the raw answer; the error's words are masked afterwards and decide nothing.
  let body: unknown
  try {
    body = JSON.parse(answer.body)
  } catch {
    throw UpstreamError.invalidAnswer(
      `${label} did not answer with JSON`,
      answer.status,
      null,
      secrets
    )
  }
  try {
    return parseDiarization(body)
  } catch {
    throw UpstreamError.invalidAnswer(
      `${label} answered in an unexpected shape`,
      answer.status,
      answer.body,
      secrets
    )
  }
}

/**
 * kiChat's `getSpeechTimestamps`: the speech regions of one WAV file, or `[]` whenever that fails,
 * since the mapping only uses them to fill gaps.
 */
export async function speechTimestamps(
  path: string,
  duration: number | null,
  target: DiarizationTarget
): Promise<SpeechRegion[]> {
  try {
    const form = new FormData()
    form.set('model', VAD_MODEL)
    form.set('file', await openAsBlob(path, { type: 'audio/wav' }), 'audio.wav')
    const answer = await postToServer(
      upstreamUrl(target.baseUrl, 'audio/speech/timestamps'),
      form,
      {
        apiKey: target.apiKey,
        timeoutMs: vadTimeoutMs(duration),
        label: 'timestamps',
        signal: target.signal,
        limiter: target.limiter,
        backoffMs: target.backoffMs
      }
    )
    if (answer.error || answer.status < 200 || answer.status >= 300) {
      console.warn('Transcription VAD failed', answer.status || answer.error)
      return []
    }
    return parseSpeechTimestamps(JSON.parse(answer.body))
  } catch (error) {
    if (target.signal?.aborted) throw error
    console.warn('Transcription VAD failed', error)
    return []
  }
}
