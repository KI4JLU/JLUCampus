import { openAsBlob } from 'node:fs'

import type { TranscriptionSpeakerCount } from '@justcampus/shared'
import { z } from 'zod'

import { bearer, ensureOk, readJson, UpstreamError, upstreamFetch } from '../http.js'
import type { SpeakerTurn } from './speakers.js'

/**
 * Speaker diarisation through the admin's HTTP endpoint (`diarizationUrl`): the normalised audio
 * goes up as multipart `file`, with `model` if set and the speaker count as a hint
 * (`num_speakers=1` for one person, `min_speakers=2` for several). The answer lists speaker turns.
 * Diarisation services differ in their envelope, so the common ones are accepted:
 * `{ segments | turns | diarization | speakers: [...] }` or a bare array, each turn with
 * `start`/`end` (or `start_time`/`end_time`) in seconds and `speaker` (or `label`, `speaker_id`).
 */

const turnSchema = z
  .object({
    start: z.number().optional(),
    end: z.number().optional(),
    start_time: z.number().optional(),
    end_time: z.number().optional(),
    speaker: z.union([z.string(), z.number()]).optional(),
    label: z.union([z.string(), z.number()]).optional(),
    speaker_id: z.union([z.string(), z.number()]).optional()
  })
  .transform((turn) => ({
    start: turn.start ?? turn.start_time,
    end: turn.end ?? turn.end_time,
    speaker: turn.speaker ?? turn.speaker_id ?? turn.label
  }))

const turnListSchema = z.array(z.unknown())

/** The turns of a diarisation answer; turns without times or speaker are left out. */
export function parseDiarization(body: unknown): SpeakerTurn[] {
  let list: unknown[] | null = null
  if (Array.isArray(body)) list = body
  else if (body && typeof body === 'object') {
    for (const key of ['segments', 'turns', 'diarization', 'speakers', 'data']) {
      const value = (body as Record<string, unknown>)[key]
      if (Array.isArray(value)) {
        list = value
        break
      }
    }
  }
  if (!list) throw new Error('No speaker turns in the answer')
  const turns: SpeakerTurn[] = []
  for (const entry of turnListSchema.parse(list)) {
    const parsed = turnSchema.safeParse(entry)
    if (!parsed.success) continue
    const { start, end, speaker } = parsed.data
    if (start === undefined || end === undefined || speaker === undefined) continue
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue
    turns.push({ start, end, speaker: String(speaker) })
  }
  return turns
}

export interface DiarizationRequest {
  url: string
  apiKey: string | null
  model: string | null
  speakerCount: TranscriptionSpeakerCount
  timeoutMs: number
  signal?: AbortSignal
}

/** Diarises one WAV file, streamed from disk. */
export async function diarizeFile(
  path: string,
  request: DiarizationRequest
): Promise<SpeakerTurn[]> {
  const form = new FormData()
  form.set('file', await openAsBlob(path, { type: 'audio/wav' }), 'audio.wav')
  if (request.model) form.set('model', request.model)
  if (request.speakerCount === 'single') form.set('num_speakers', '1')
  if (request.speakerCount === 'multi') form.set('min_speakers', '2')
  const label = 'Der Diarization-Server'
  const response = await ensureOk(
    await upstreamFetch(request.url, {
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
    return parseDiarization(body)
  } catch {
    throw new UpstreamError(`${label} answered in an unexpected shape`, response.status)
  }
}
