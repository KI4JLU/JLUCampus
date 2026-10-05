import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'

import { TRANSCRIPTION_PEAKS_PER_SECOND, type TranscriptionJobPeaks } from '@justcampus/shared'

/**
 * The waveform of a job's audio, computed by the analysis from the normalised WAV that ffmpeg
 * wrote (T-12, T-19): the loudest sample of every `1 / perSecond` seconds. Browsers decode only
 * files up to `TRANSCRIPTION_WAVEFORM_DECODE_MAX_BYTES` themselves; larger accepted files get
 * these peaks instead. The WAV is streamed, never held in memory as a whole.
 */

/** Where the samples of a 16-bit PCM WAV lie, and how they are laid out. */
export interface WavLayout {
  sampleRate: number
  channels: number
  dataOffset: number
  dataBytes: number
}

/** Reads the RIFF chunks up to `data`; `null` for anything but 16-bit PCM. */
export async function readWavLayout(path: string): Promise<WavLayout | null> {
  const file = await open(path, 'r')
  try {
    const { size } = await file.stat()
    const read = async (offset: number, length: number): Promise<Buffer> => {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await file.read(buffer, 0, length, offset)
      return buffer.subarray(0, bytesRead)
    }
    const riff = await read(0, 12)
    if (riff.toString('ascii', 0, 4) !== 'RIFF' || riff.toString('ascii', 8, 12) !== 'WAVE') {
      return null
    }
    let offset = 12
    let format: { sampleRate: number; channels: number } | null = null
    while (offset + 8 <= size) {
      const header = await read(offset, 8)
      const id = header.toString('ascii', 0, 4)
      const length = header.readUInt32LE(4)
      const body = offset + 8
      if (id === 'fmt ') {
        const fmt = await read(body, 16)
        if (fmt.length < 16) return null
        const pcm = fmt.readUInt16LE(0) === 1 || fmt.readUInt16LE(0) === 0xfffe
        if (!pcm || fmt.readUInt16LE(14) !== 16) return null
        format = { channels: fmt.readUInt16LE(2), sampleRate: fmt.readUInt32LE(4) }
      } else if (id === 'data') {
        if (!format || format.channels < 1 || format.sampleRate < 1) return null
        // A streamed WAV may name no length (0 or the maximum); the file's end then says it.
        const available = size - body
        const dataBytes = length > 0 && length <= available ? length : available
        return { ...format, dataOffset: body, dataBytes }
      }
      offset = body + length + (length % 2)
    }
    return null
  } finally {
    await file.close()
  }
}

const FULL_SCALE = 32_768

/** Collects the loudest sample per bucket from 16-bit samples handed over in any pieces. */
export class PeakCollector {
  private readonly bucketSamples: number
  private readonly peaks: number[] = []
  private current = 0
  private inBucket = 0
  private carry: number | null = null
  private samples = 0

  constructor(
    private readonly layout: Pick<WavLayout, 'sampleRate' | 'channels'>,
    perSecond = TRANSCRIPTION_PEAKS_PER_SECOND
  ) {
    // All channels of a frame count towards its bucket.
    this.bucketSamples =
      Math.max(1, Math.round(layout.sampleRate / perSecond)) * Math.max(1, layout.channels)
  }

  /** Takes the next bytes; an odd byte waits for the next piece. */
  push(chunk: Uint8Array): void {
    let index = 0
    if (this.carry !== null && chunk.length > 0) {
      this.sample((((chunk[0]! << 8) | this.carry) << 16) >> 16)
      this.carry = null
      index = 1
    }
    const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    for (; index + 1 < chunk.length; index += 2) this.sample(view.getInt16(index, true))
    if (index < chunk.length) this.carry = chunk[index]!
  }

  private sample(value: number): void {
    const magnitude = value < 0 ? -value : value
    if (magnitude > this.current) this.current = magnitude
    this.samples++
    if (++this.inBucket === this.bucketSamples) {
      this.peaks.push(this.current)
      this.current = 0
      this.inBucket = 0
    }
  }

  /**
   * The peaks as bytes scaled to the loudest, and the audio's length. As in the browser's own
   * decoding, near silence is not blown up: the loudest counts as at least 1 % of full scale.
   */
  finish(): { bytes: Uint8Array; duration: number } {
    if (this.inBucket > 0) this.peaks.push(this.current)
    const loudest = Math.max(FULL_SCALE * 0.01, maxOf(this.peaks))
    const bytes = Uint8Array.from(this.peaks, (peak) => Math.round((peak / loudest) * 255))
    const frames = this.samples / Math.max(1, this.layout.channels)
    return { bytes, duration: frames / this.layout.sampleRate }
  }
}

function maxOf(values: readonly number[]): number {
  let max = 0
  for (const value of values) if (value > max) max = value
  return max
}

/** The waveform of a 16-bit PCM WAV as the API answers it; `null` for another format. */
export async function wavPeaks(
  path: string,
  signal?: AbortSignal
): Promise<TranscriptionJobPeaks | null> {
  const layout = await readWavLayout(path)
  if (!layout) return null
  const collector = new PeakCollector(layout)
  if (layout.dataBytes > 0) {
    const stream = createReadStream(path, {
      start: layout.dataOffset,
      end: layout.dataOffset + layout.dataBytes - 1,
      signal
    })
    for await (const chunk of stream) collector.push(chunk as Buffer)
  }
  const { bytes, duration } = collector.finish()
  return {
    perSecond: TRANSCRIPTION_PEAKS_PER_SECOND,
    duration,
    peaks: Buffer.from(bytes).toString('base64')
  }
}
