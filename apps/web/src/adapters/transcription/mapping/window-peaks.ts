import { useEffect, useState } from 'react'
import { TRANSCRIPTION_WAVEFORM_DECODE_MAX_BYTES } from '@justcampus/shared'

/**
 * Waveform data by time for the sample window editor, after kiChat's editor player: a fixed number
 * of peaks per second, so a few seconds of a long file still show their detail. Files above the
 * decode limit, or that cannot be decoded, give `null`; the editor then draws placeholder bars.
 */

/** Peaks per second of audio, as kiChat's `WAVEFORM_PEAKS_PER_SECOND`. */
export const PEAKS_PER_SECOND = 20

/** Decoding at a low rate keeps a long file's samples small; peaks need no more. */
const DECODE_SAMPLE_RATE = 8000

export interface TimePeaks {
  /** Normalised to the loudest, one per `1 / PEAKS_PER_SECOND` seconds. */
  peaks: number[]
  duration: number
}

/**
 * The loudest sample of every `1 / perSecond` seconds, scaled so the loudest is 1. A bucket is
 * sampled, not scanned in full.
 */
export function timePeaksOf(
  channel: Float32Array,
  sampleRate: number,
  perSecond: number = PEAKS_PER_SECOND
): number[] {
  const bucketSize = Math.max(1, Math.round(sampleRate / perSecond))
  const count = Math.ceil(channel.length / bucketSize)
  const peaks = new Array<number>(count).fill(0)
  for (let bucket = 0; bucket < count; bucket++) {
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
  let loudest = 0.01
  for (const peak of peaks) if (peak > loudest) loudest = peak
  return peaks.map((peak) => peak / loudest)
}

/** The peaks between two times, at least one. */
export function peaksBetween(
  data: TimePeaks,
  start: number,
  end: number,
  perSecond: number = PEAKS_PER_SECOND
): number[] {
  const from = Math.max(0, Math.floor(start * perSecond))
  const to = Math.min(data.peaks.length, Math.max(from + 1, Math.ceil(end * perSecond)))
  const slice = data.peaks.slice(from, to)
  return slice.length > 0 ? slice : [0]
}

async function decode(bytes: ArrayBuffer): Promise<TimePeaks | null> {
  try {
    const context = new OfflineAudioContext(1, 1, DECODE_SAMPLE_RATE)
    const buffer = await context.decodeAudioData(bytes)
    return {
      peaks: timePeaksOf(buffer.getChannelData(0), buffer.sampleRate),
      duration: buffer.duration
    }
  } catch {
    return null
  }
}

/** Reads a response up to the decode limit; `null` beyond it. */
async function limitedBytes(response: Response): Promise<ArrayBuffer | null> {
  if (!response.ok || !response.body) return null
  if (Number(response.headers.get('Content-Length')) > TRANSCRIPTION_WAVEFORM_DECODE_MAX_BYTES) {
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
  return bytes.buffer
}

const blobPeaks = new WeakMap<Blob, Promise<TimePeaks | null>>()
/** By job: its signed URLs change, its audio does not. */
const jobPeaks = new Map<string, Promise<TimePeaks | null>>()

/** Where the editor's audio comes from: the local file, or the job's signed URL. */
export type PeaksSource = { blob: Blob } | { jobId: string; url: string | null }

function load(source: PeaksSource): Promise<TimePeaks | null> | null {
  if ('blob' in source) {
    if (source.blob.size > TRANSCRIPTION_WAVEFORM_DECODE_MAX_BYTES) return Promise.resolve(null)
    let peaks = blobPeaks.get(source.blob)
    if (!peaks) {
      peaks = source.blob.arrayBuffer().then(decode)
      blobPeaks.set(source.blob, peaks)
    }
    return peaks
  }
  const cached = jobPeaks.get(source.jobId)
  if (cached) return cached
  if (!source.url) return null
  const peaks = fetch(source.url)
    .then(limitedBytes)
    .then((bytes) => (bytes ? decode(bytes) : null))
    .catch(() => null)
  jobPeaks.set(source.jobId, peaks)
  return peaks
}

/** The peaks of the editor's audio once decoded; `null` until then or when there are none. */
export function useTimePeaks(source: PeaksSource | null): TimePeaks | null {
  const [loaded, setLoaded] = useState<{ key: unknown; peaks: TimePeaks | null } | null>(null)
  const key = source ? ('blob' in source ? source.blob : source.jobId) : null
  const url = source && 'url' in source ? source.url : null
  useEffect(() => {
    if (!source) return
    const pending = load(source)
    if (!pending) return
    let current = true
    void pending.then((peaks) => {
      if (current) setLoaded({ key, peaks })
    })
    return () => {
      current = false
    }
    // The source object is rebuilt each render; its key and URL say when it changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, url])
  return loaded?.key === key ? loaded.peaks : null
}
