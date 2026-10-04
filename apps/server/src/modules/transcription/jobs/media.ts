import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { env } from '../../../env.js'

/**
 * The worker's media steps with `ffmpeg` and `ffprobe` (`TRANSCRIPTION_FFMPEG`,
 * `TRANSCRIPTION_FFPROBE`): checking that an upload is decodable audio, normalising it to 16 kHz
 * mono PCM (also taking the audio out of MP4 videos), and cutting chunks and samples. Files lie in
 * a temporary directory per run below `TRANSCRIPTION_WORK_DIR`.
 */

/** The format every later step works on, as kiChat normalised: 16 kHz, mono, `pcm_s16le`. */
export const NORMALIZED_SAMPLE_RATE = 16_000

/** A media tool that failed; `detail` is the end of its error output. */
export class MediaToolError extends Error {
  constructor(
    message: string,
    readonly detail: string
  ) {
    super(message)
    this.name = 'MediaToolError'
  }
}

/** The end of a tool's error output kept for logs. */
const STDERR_MAX = 4000

/** Runs a tool; resolves with its standard output, rejects with the end of its error output. */
export function runTool(
  command: string,
  args: readonly string[],
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(options.signal.reason)
      return
    }
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (error: unknown, output?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve(output ?? '')
    }
    const abort = (): void => {
      child.kill('SIGKILL')
      finish(options.signal?.reason ?? new Error('Aborted'))
    }
    const timer = setTimeout(
      () => {
        child.kill('SIGKILL')
        finish(new MediaToolError(`${command} timed out`, stderr.slice(-STDERR_MAX)))
      },
      options.timeoutMs ?? 30 * 60_000
    )
    options.signal?.addEventListener('abort', abort, { once: true })
    child.stdout.setEncoding('utf8').on('data', (data: string) => {
      stdout += data
    })
    child.stderr.setEncoding('utf8').on('data', (data: string) => {
      stderr = (stderr + data).slice(-STDERR_MAX)
    })
    child.on('error', (error) =>
      finish(new MediaToolError(`${command} could not start`, String(error)))
    )
    child.on('close', (code) => {
      if (code === 0) finish(null, stdout)
      else finish(new MediaToolError(`${command} exited with ${code}`, stderr.slice(-STDERR_MAX)))
    })
  })
}

/** What `ffprobe` found in a file. */
export interface MediaInfo {
  /** Seconds, if the container or an audio stream tells. */
  duration: number | null
  /** Whether there is an audio stream to transcribe. */
  hasAudio: boolean
}

/** Reads `ffprobe`'s JSON: the container's duration, else the longest audio stream's. */
export function parseProbe(output: string): MediaInfo {
  const probe = JSON.parse(output) as {
    format?: { duration?: string }
    streams?: Array<{ codec_type?: string; duration?: string }>
  }
  const audio = (probe.streams ?? []).filter((stream) => stream.codec_type === 'audio')
  const seconds = (value: string | undefined): number | null => {
    const number = value === undefined ? Number.NaN : Number(value)
    return Number.isFinite(number) && number > 0 ? number : null
  }
  const streamDuration = audio
    .map((stream) => seconds(stream.duration))
    .reduce<number | null>(
      (max, value) => (value !== null && (max === null || value > max) ? value : max),
      null
    )
  return { duration: seconds(probe.format?.duration) ?? streamDuration, hasAudio: audio.length > 0 }
}

/** Probes a file; throws a `MediaToolError` when ffprobe cannot read it. */
export async function probeMedia(path: string, signal?: AbortSignal): Promise<MediaInfo> {
  const output = await runTool(
    env.TRANSCRIPTION_FFPROBE,
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration:stream=codec_type,duration',
      '-of',
      'json',
      path
    ],
    { signal, timeoutMs: 120_000 }
  )
  try {
    return parseProbe(output)
  } catch {
    throw new MediaToolError('ffprobe answered no JSON', output.slice(0, 200))
  }
}

/** Decodes the first audio stream (of audio or video) into 16 kHz mono 16-bit WAV. */
export async function normalizeAudio(
  input: string,
  output: string,
  signal?: AbortSignal
): Promise<void> {
  await runTool(
    env.TRANSCRIPTION_FFMPEG,
    [
      '-nostdin',
      '-hide_banner',
      '-v',
      'error',
      '-y',
      '-i',
      input,
      '-map',
      '0:a:0',
      '-vn',
      '-ac',
      '1',
      '-ar',
      String(NORMALIZED_SAMPLE_RATE),
      '-c:a',
      'pcm_s16le',
      '-f',
      'wav',
      output
    ],
    { signal }
  )
}

/** Cuts `[start, end)` seconds of a normalised WAV into a WAV of its own. */
export async function cutAudio(
  input: string,
  output: string,
  start: number,
  end: number,
  signal?: AbortSignal
): Promise<void> {
  await runTool(
    env.TRANSCRIPTION_FFMPEG,
    [
      '-nostdin',
      '-hide_banner',
      '-v',
      'error',
      '-y',
      '-ss',
      start.toFixed(3),
      '-t',
      Math.max(0.01, end - start).toFixed(3),
      '-i',
      input,
      '-ac',
      '1',
      '-ar',
      String(NORMALIZED_SAMPLE_RATE),
      '-c:a',
      'pcm_s16le',
      '-f',
      'wav',
      output
    ],
    { signal, timeoutMs: 10 * 60_000 }
  )
}

/** A fresh temporary directory for one run; `dispose` removes it with everything in it. */
export async function workDirectory(): Promise<{ path: string; dispose: () => Promise<void> }> {
  const path = await mkdtemp(
    join(env.TRANSCRIPTION_WORK_DIR ?? tmpdir(), 'justcampus-transcription-')
  )
  return { path, dispose: () => rm(path, { recursive: true, force: true }) }
}
