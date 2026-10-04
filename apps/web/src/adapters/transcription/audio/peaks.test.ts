import { afterEach, describe, expect, it, vi } from 'vitest'
import { TRANSCRIPTION_WAVEFORM_DECODE_MAX_BYTES } from '@justcampus/shared'
import {
  blobWaveform,
  computePeaks,
  formatMegabytes,
  formatTime,
  placeholderPeaks,
  urlWaveform
} from './peaks'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('computePeaks', () => {
  it('scales the loudest bucket to 1', () => {
    // Halves and quarters are exact in 32 bits.
    const channel = new Float32Array([0, 0.125, -0.5, 0.25, 0, 0, 0.0625, -0.0625])
    expect(computePeaks(channel, 4)).toEqual([0.25, 1, 0, 0.125])
  })

  it('stays finite for silence and short audio', () => {
    expect(computePeaks(new Float32Array(10), 4)).toEqual([0, 0, 0, 0])
    expect(computePeaks(new Float32Array([0.5]), 3)).toEqual([1, 0, 0])
  })

  it('draws even placeholder bars', () => {
    expect(placeholderPeaks(3)).toEqual([0.45, 0.45, 0.45])
  })
})

describe('the decode limit', () => {
  it('does not decode files over 100 MB', async () => {
    const huge = { size: TRANSCRIPTION_WAVEFORM_DECODE_MAX_BYTES + 1 } as Blob
    await expect(blobWaveform(huge)).resolves.toBeNull()
  })

  it('does not download remote audio that declares more', async () => {
    const cancel = vi.fn(async () => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        headers: new Headers({
          'Content-Length': String(TRANSCRIPTION_WAVEFORM_DECODE_MAX_BYTES + 1)
        }),
        body: { cancel }
      }))
    )
    await expect(urlWaveform('https://storage.example/a.wav')).resolves.toBeNull()
    expect(cancel).toHaveBeenCalled()
  })
})

describe('formatting', () => {
  it('shows minutes and seconds, hours from an hour on', () => {
    expect(formatTime(0)).toBe('00:00')
    expect(formatTime(11.24)).toBe('00:11')
    expect(formatTime(3725)).toBe('01:02:05')
    expect(formatTime(Number.POSITIVE_INFINITY)).toBe('00:00')
    expect(formatTime(-1)).toBe('00:00')
  })

  it('shows sizes in megabytes with one decimal', () => {
    expect(formatMegabytes(495_752)).toBe('0.5 MB')
    expect(formatMegabytes(524_288_000)).toBe('500.0 MB')
  })
})
