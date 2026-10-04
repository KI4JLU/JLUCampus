import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TRANSCRIPTION_PEAKS_PER_SECOND, transcriptionJobPeaksSchema } from '@justcampus/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PeakCollector, readWavLayout, wavPeaks } from './peaks.js'

/** A 16-bit PCM WAV with an extra chunk before the samples, as ffmpeg writes `LIST`. */
function wav(samples: readonly number[], sampleRate = 16_000, channels = 1): Buffer {
  const data = Buffer.alloc(samples.length * 2)
  samples.forEach((sample, index) => data.writeInt16LE(sample, index * 2))
  const fmt = Buffer.alloc(16)
  fmt.writeUInt16LE(1, 0)
  fmt.writeUInt16LE(channels, 2)
  fmt.writeUInt32LE(sampleRate, 4)
  fmt.writeUInt32LE(sampleRate * channels * 2, 8)
  fmt.writeUInt16LE(channels * 2, 12)
  fmt.writeUInt16LE(16, 14)
  const list = Buffer.from('INFOISFT\u0003\u0000\u0000\u0000ab\u0000\u0000', 'latin1')
  const chunk = (id: string, body: Buffer): Buffer => {
    const header = Buffer.alloc(8)
    header.write(id, 0, 'ascii')
    header.writeUInt32LE(body.length, 4)
    return Buffer.concat([header, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)])
  }
  const body = Buffer.concat([
    Buffer.from('WAVE', 'ascii'),
    chunk('fmt ', fmt),
    chunk('LIST', list),
    chunk('data', data)
  ])
  const riff = Buffer.alloc(8)
  riff.write('RIFF', 0, 'ascii')
  riff.writeUInt32LE(body.length, 4)
  return Buffer.concat([riff, body])
}

let directory = ''

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'transcription-peaks-'))
})

afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('server waveform (T-12, T-19)', () => {
  it('takes the loudest sample of every twentieth of a second, scaled to the loudest', async () => {
    // 100 Hz sample rate: five samples per peak; two full buckets and a partial one.
    const samples = [0, 100, -400, 0, 0, 0, 0, 800, 0, 0, -200]
    const path = join(directory, 'tone.wav')
    await writeFile(path, wav(samples, 100))
    expect(await readWavLayout(path)).toMatchObject({ sampleRate: 100, channels: 1, dataBytes: 22 })
    const peaks = await wavPeaks(path)
    expect(transcriptionJobPeaksSchema.parse(peaks)).toMatchObject({
      perSecond: TRANSCRIPTION_PEAKS_PER_SECOND,
      duration: 0.11
    })
    expect([...Buffer.from(peaks!.peaks, 'base64')]).toEqual([128, 255, 64])
  })

  it('reads samples split anywhere, also inside a sample', () => {
    const collector = new PeakCollector({ sampleRate: 40, channels: 1 })
    const bytes = wav([1000, -2000, 0, 3000], 40).subarray(-8)
    collector.push(bytes.subarray(0, 3))
    collector.push(bytes.subarray(3, 5))
    collector.push(bytes.subarray(5))
    expect([...collector.finish().bytes]).toEqual([170, 255])
  })

  it('counts a stereo frame as one moment and leaves near silence flat', () => {
    const collector = new PeakCollector({ sampleRate: 20, channels: 2 })
    const bytes = new Uint8Array(new Int16Array([1, -3, 2, 0]).buffer)
    collector.push(bytes)
    const { bytes: peaks, duration } = collector.finish()
    expect(duration).toBe(0.1)
    expect([...peaks]).toEqual([2, 2])
  })

  it('refuses anything but 16-bit PCM WAV', async () => {
    const path = join(directory, 'not.wav')
    await writeFile(path, Buffer.from('ID3 not a wave file at all'))
    expect(await wavPeaks(path)).toBeNull()
  })
})
