import type { transcriptionDispatchSchema, TranscriptionSpeaker } from '@justcampus/shared'
import type { z } from 'zod'

type DispatchInput = z.output<typeof transcriptionDispatchSchema>
export type Issue = { path: Array<string | number>; message: string }

/** Windows may end this much after the measured end: decoders differ by a few frames. */
const DURATION_TOLERANCE_SECONDS = 0.5

/** What the browser sends as type, else what the extension says. Recordings often send none. */
const EXTENSION_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  ogg: 'audio/ogg'
}

/** The file's own name, without any path a browser or OS put in front. */
export function cleanFilename(filename: string): string {
  return (filename.replaceAll('\\', '/').split('/').pop() ?? '').trim()
}

/**
 * The `Content-Type` the signed upload is bound to: the browser's type if it is a plain MIME
 * type, else the extension's, else `application/octet-stream` (kiChat's fallback).
 */
export function uploadContentType(filename: string, mimeType: string): string {
  const type = mimeType.trim().toLowerCase()
  if (/^[a-z0-9][\w.+-]*\/[\w.+-]+$/.test(type)) return type
  const extension = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : ''
  return EXTENSION_TYPES[extension] ?? 'application/octet-stream'
}

/**
 * Problems of a dispatch beyond its schema (T-18 to T-20): windows must lie within the measured
 * audio, names and colours must belong to an analysed voice or one of the windows (voices added
 * by hand), and the correction must be set up when asked for.
 */
export function dispatchIssues(
  input: DispatchInput,
  job: { speakers: readonly Pick<TranscriptionSpeaker, 'id'>[]; duration: number | null },
  options: { correctionAvailable: boolean }
): Issue[] {
  const issues: Issue[] = []
  const snippets = input.snippets
  const known = new Set([
    ...job.speakers.map((speaker) => speaker.id),
    ...snippets.map((snippet) => snippet.id)
  ])
  if (job.duration !== null) {
    const limit = job.duration + DURATION_TOLERANCE_SECONDS
    snippets.forEach((snippet, index) => {
      if (snippet.start >= job.duration! || snippet.end > limit) {
        issues.push({ path: ['snippets', index], message: 'The window lies outside the audio' })
      }
    })
  }
  for (const id of Object.keys(input.mapping)) {
    if (!known.has(id)) issues.push({ path: ['mapping', id], message: 'Unknown speaker' })
  }
  for (const id of Object.keys(input.colors)) {
    if (!known.has(id)) issues.push({ path: ['colors', id], message: 'Unknown speaker' })
  }
  if (input.llmCorrection && !options.correctionAvailable) {
    issues.push({ path: ['llmCorrection'], message: 'The correction is not set up' })
  }
  return issues
}
