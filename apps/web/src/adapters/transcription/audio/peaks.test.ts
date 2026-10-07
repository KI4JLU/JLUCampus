import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TRANSCRIPTION_WAVEFORM_DECODE_MAX_BYTES,
  type TranscriptionJobPeaks
} from '@justcampus/shared'
import { getJobPeaks } from '../api'
import {
  blobWaveform,
  computePeaks,
  decodesLocally,
  formatMegabytes,
  formatTime,
  jobWaveform,
  overviewPeaks,
  placeholderPeaks,
  serverTimePeaks,
  urlWaveform,
  WEBM_DECODE_MAX_SECONDS
} from './peaks'

vi.mock('../api', () => ({ getJobPeaks: vi.fn() }))

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

  it('decodes WebM only of a known duration up to 20 minutes, however small', async () => {
    // An hour of quiet meeting at a variable bitrate: under a megabyte, decoded 660 MB.
    const meeting = { size: 800 * 1024, type: 'audio/webm;codecs=opus' } as Blob
    expect(decodesLocally(meeting)).toBe(false)
    expect(decodesLocally(meeting, 3600)).toBe(false)
    await expect(blobWaveform(meeting, 3600)).resolves.toBeNull()
    expect(decodesLocally(meeting, null)).toBe(false)
    expect(decodesLocally(meeting, Infinity)).toBe(false)
    expect(decodesLocally(meeting, Number.NaN)).toBe(false)
    expect(decodesLocally(meeting, WEBM_DECODE_MAX_SECONDS)).toBe(true)
    expect(decodesLocally(meeting, WEBM_DECODE_MAX_SECONDS + 1)).toBe(false)
    // Audio by URL has no type: its name tells.
    expect(decodesLocally({ size: 1024, name: 'max-20261007-101500.webm' })).toBe(false)
    expect(decodesLocally({ size: 1024, name: 'max-20261007-101500.webm' }, 60)).toBe(true)
  })

  it('keeps the limit on the bytes of other formats', () => {
    const limit = TRANSCRIPTION_WAVEFORM_DECODE_MAX_BYTES
    expect(decodesLocally({ size: limit, name: 'interview.wav' })).toBe(true)
    expect(decodesLocally({ size: limit, type: 'audio/ogg' })).toBe(true)
    expect(decodesLocally({ size: limit, type: 'audio/wav', name: 'a.webm' })).toBe(true)
    expect(decodesLocally({ size: limit + 1 })).toBe(false)
    expect(decodesLocally({ size: limit + 1, type: 'audio/webm' }, 60)).toBe(false)
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

describe('the server waveform of large files (T-12)', () => {
  const peaks = (bytes: number[]): TranscriptionJobPeaks => ({
    perSecond: 20,
    duration: bytes.length / 20,
    peaks: btoa(String.fromCharCode(...bytes))
  })

  it('reads the analysis bytes as peaks from 0 to 1', () => {
    expect(serverTimePeaks(peaks([0, 51, 255]))).toEqual([0, 0.2, 1])
  })

  it('folds peaks by time into the players’ fixed number, the loudest of each stretch', () => {
    expect(overviewPeaks([0.1, 0.5, 0.2, 0.25], 2)).toEqual([1, 0.5])
    // Fewer peaks than bars are stretched.
    expect(overviewPeaks([0.5, 1], 4)).toEqual([0.5, 0.5, 1, 1])
    expect(overviewPeaks([], 3)).toEqual(placeholderPeaks(3))
  })

  it('takes a job’s waveform once there is one', async () => {
    const fetchPeaks = vi.mocked(getJobPeaks)
    fetchPeaks.mockResolvedValueOnce(null)
    expect(await jobWaveform('job-large')).toBeNull()
    // Not there before the analysis: asked for again later.
    fetchPeaks.mockResolvedValueOnce(peaks(new Array(400).fill(255)))
    const waveform = await jobWaveform('job-large')
    expect(waveform?.duration).toBe(20)
    expect(waveform?.peaks).toHaveLength(200)
    expect(await jobWaveform('job-large')).toEqual(waveform)
    expect(fetchPeaks).toHaveBeenCalledTimes(2)
  })
})
