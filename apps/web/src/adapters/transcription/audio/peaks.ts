import {
  TRANSCRIPTION_WAVEFORM_DECODE_MAX_BYTES,
  type TranscriptionJobPeaks
} from '@justcampus/shared'
import { getJobAudioUrl, getJobPeaks } from '../api'

/**
 * Waveform data for the players, after kiChat's `WaveformAudioPlayer`: a fixed number of
 * normalised peaks, resampled to bars at draw time so the waveform stays crisp at any width.
 */

/** Peaks per waveform. */
export const PEAK_RESOLUTION = 200

/** Bars drawn when there is no decoded waveform (too large, or not decodable). */
export function placeholderPeaks(resolution = PEAK_RESOLUTION): number[] {
  return new Array<number>(resolution).fill(0.45)
}

/**
 * The loudest sample of each of `resolution` buckets, scaled so the loudest bucket is 1. A bucket
 * is sampled, not scanned in full: a preview does not need every sample.
 */
export function computePeaks(channel: Float32Array, resolution = PEAK_RESOLUTION): number[] {
  const bucketSize = Math.max(1, Math.floor(channel.length / resolution))
  const peaks = new Array<number>(resolution).fill(0)
  for (let bucket = 0; bucket < resolution; bucket++) {
    const start = bucket * bucketSize
    const end = Math.min(start + bucketSize, channel.length)
    const step = Math.max(1, Math.floor((end - start) / 64))
    let max = 0
    for (let index = start; index < end; index += step) {
      const value = Math.abs(channel[index] ?? 0)
      if (value > max) max = value
    }
    peaks[bucket] = max
  }
  const loudest = Math.max(...peaks, 0.01)
  return peaks.map((peak) => peak / loudest)
}

export interface DecodedWaveform {
  peaks: number[]
  /** Seconds, from the decoded audio; recordings often report no duration of their own. */
  duration: number
}

let sharedContext: AudioContext | null = null

function audioContext(): AudioContext {
  sharedContext ??= new AudioContext()
  return sharedContext
}

/** Decodes audio bytes with Web Audio; `null` when the browser cannot decode them. */
export async function decodeWaveform(bytes: ArrayBuffer): Promise<DecodedWaveform | null> {
  try {
    const buffer = await audioContext().decodeAudioData(bytes)
    return { peaks: computePeaks(buffer.getChannelData(0)), duration: buffer.duration }
  } catch {
    return null
  }
}

// Decoded per file, so re-rendered lists do not decode again.
const blobCache = new WeakMap<Blob, Promise<DecodedWaveform | null>>()

/**
 * The waveform of a local file or recording; `null` above `TRANSCRIPTION_WAVEFORM_DECODE_MAX_BYTES`
 * (decoding inflates the whole file into memory) or when it cannot be decoded.
 */
export function blobWaveform(blob: Blob): Promise<DecodedWaveform | null> {
  if (blob.size > TRANSCRIPTION_WAVEFORM_DECODE_MAX_BYTES) return Promise.resolve(null)
  let decoded = blobCache.get(blob)
  if (!decoded) {
    decoded = blob.arrayBuffer().then(decodeWaveform)
    blobCache.set(blob, decoded)
  }
  return decoded
}

/**
 * The waveform of remote audio, e.g. a job's audio URL; `null` when it is larger than the limit (by its
 * `Content-Length` or while reading), unreachable or not decodable.
 */
export async function urlWaveform(
  url: string,
  signal?: AbortSignal
): Promise<DecodedWaveform | null> {
  let response: Response
  try {
    // The API may be on another origin (desktop app, development); its audio needs the session.
    response = await fetch(url, { signal, credentials: 'include' })
  } catch {
    return null
  }
  if (!response.ok || !response.body) return null
  const declared = Number(response.headers.get('Content-Length'))
  if (declared > TRANSCRIPTION_WAVEFORM_DECODE_MAX_BYTES) {
    await response.body.cancel()
    return null
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > TRANSCRIPTION_WAVEFORM_DECODE_MAX_BYTES) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return decodeWaveform(bytes.buffer)
}

/** The analysis's peaks as numbers from 0 to 1, one per `1 / perSecond` seconds. */
export function serverTimePeaks(peaks: TranscriptionJobPeaks): number[] {
  return Array.from(atob(peaks.peaks), (char) => char.charCodeAt(0) / 255)
}

/**
 * `resolution` peaks of the whole audio from peaks by time: the loudest of each stretch, scaled
 * so the loudest is 1. Fewer peaks than that are stretched.
 */
export function overviewPeaks(
  timePeaks: readonly number[],
  resolution = PEAK_RESOLUTION
): number[] {
  if (timePeaks.length === 0) return placeholderPeaks(resolution)
  const peaks = new Array<number>(resolution).fill(0)
  for (let bucket = 0; bucket < resolution; bucket++) {
    const from = Math.floor((bucket * timePeaks.length) / resolution)
    const to = Math.max(from + 1, Math.floor(((bucket + 1) * timePeaks.length) / resolution))
    let max = 0
    for (let index = from; index < to; index++) max = Math.max(max, timePeaks[index] ?? 0)
    peaks[bucket] = max
  }
  const loudest = Math.max(...peaks, 0.01)
  return peaks.map((peak) => peak / loudest)
}

/** A job's waveform from the analysis by time, and the audio's length. */
export interface JobTimePeaks {
  peaks: number[]
  duration: number
}

// By job: the analysis computes the waveform once. A missing one is asked for again later.
const jobPeaksCache = new Map<string, Promise<JobTimePeaks | null>>()

/**
 * The waveform the analysis computed for a job (T-12, T-19), for audio too large to decode here;
 * `null` before the analysis, without one or when the request fails.
 */
export function jobTimePeaks(jobId: string): Promise<JobTimePeaks | null> {
  let pending = jobPeaksCache.get(jobId)
  if (!pending) {
    pending = getJobPeaks(jobId)
      .then((peaks) => (peaks ? { peaks: serverTimePeaks(peaks), duration: peaks.duration } : null))
      .catch(() => null)
      .then((result) => {
        if (!result) jobPeaksCache.delete(jobId)
        return result
      })
    jobPeaksCache.set(jobId, pending)
  }
  return pending
}

/** A job's waveform from the analysis, as the players draw it. */
export async function jobWaveform(jobId: string): Promise<DecodedWaveform | null> {
  const time = await jobTimePeaks(jobId)
  return time ? { peaks: overviewPeaks(time.peaks), duration: time.duration } : null
}

/** Peaks of the result's global waveform, kiChat's `WAVEFORM_PEAK_RESOLUTION`. */
export const GLOBAL_PEAK_RESOLUTION = 400

/** A source file's range on the transcript's time line. */
export interface TimelineRange {
  startTime: number
  endTime: number
}

/**
 * One waveform over the time line of several source files, after kiChat's global
 * `computeWaveformPeaks`: each bucket takes the peak of the file whose `[startTime, endTime)` holds
 * its middle, at the same fraction of that file's peaks, and the whole is scaled so the loudest is
 * 1. `null` while no file has peaks; files without peaks stay silent.
 */
export function globalPeaks(
  sources: readonly TimelineRange[],
  perSource: ReadonlyArray<readonly number[] | null>,
  total: number,
  resolution = GLOBAL_PEAK_RESOLUTION
): number[] | null {
  if (total <= 0 || sources.length === 0 || perSource.every((peaks) => !peaks)) return null
  const peaks = new Array<number>(resolution).fill(0)
  for (let bucket = 0; bucket < resolution; bucket++) {
    const time = ((bucket + 0.5) / resolution) * total
    const index = sources.findIndex((source) => time >= source.startTime && time < source.endTime)
    const source = sources[index]
    const filePeaks = perSource[index]
    if (!source || !filePeaks || filePeaks.length === 0) continue
    const length = source.endTime - source.startTime
    if (length <= 0) continue
    const fraction = (time - source.startTime) / length
    peaks[bucket] =
      filePeaks[Math.min(filePeaks.length - 1, Math.floor(fraction * filePeaks.length))] ?? 0
  }
  const loudest = Math.max(...peaks, 0.01)
  return peaks.map((peak) => peak / loudest)
}

// By job: a transcript's files are decoded once per page, not every time it opens.
const sourceCache = new Map<string, Promise<DecodedWaveform | null>>()

/**
 * The waveform of one source file of a transcript, for the global waveform: its audio decoded here
 * up to `TRANSCRIPTION_WAVEFORM_DECODE_MAX_BYTES`, else (or when that fails) the one the analysis
 * computed; `null` without either. A missing one is asked for again later.
 */
export function sourceWaveform(jobId: string, size: number): Promise<DecodedWaveform | null> {
  let pending = sourceCache.get(jobId)
  if (!pending) {
    const decoded =
      size > TRANSCRIPTION_WAVEFORM_DECODE_MAX_BYTES
        ? Promise.resolve(null)
        : getJobAudioUrl(jobId)
            .then((media) => urlWaveform(media.url))
            .catch(() => null)
    pending = decoded
      .then((result) => result ?? jobWaveform(jobId))
      .then((result) => {
        if (!result) sourceCache.delete(jobId)
        return result
      })
    sourceCache.set(jobId, pending)
  }
  return pending
}

/** `mm:ss`, or `hh:mm:ss` from an hour on; anything not a time shows `00:00`. */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00'
  const hours = Math.floor(seconds / 3600)
  const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')
  const rest = String(Math.floor(seconds % 60)).padStart(2, '0')
  return hours > 0 ? `${String(hours).padStart(2, '0')}:${minutes}:${rest}` : `${minutes}:${rest}`
}

/** A file size in megabytes with one decimal, as kiChat shows it (`12.3 MB`). */
export function formatMegabytes(bytes: number): string {
  return Number.isFinite(bytes) ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : ''
}
