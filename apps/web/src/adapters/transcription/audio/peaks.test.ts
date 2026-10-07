import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  TRANSCRIPTION_WAVEFORM_DECODE_MAX_BYTES,
  type TranscriptionJobPeaks
} from '@justcampus/shared'
import { getJobAudioUrl, getJobPeaks } from '../api'
import {
  blobWaveform,
  computePeaks,
  formatMegabytes,
  formatTime,
  globalPeaks,
  jobWaveform,
  overviewPeaks,
  placeholderPeaks,
  serverTimePeaks,
  sourceWaveform,
  urlWaveform
} from './peaks'

vi.mock('../api', () => ({ getJobPeaks: vi.fn(), getJobAudioUrl: vi.fn() }))

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

describe('globalPeaks', () => {
  const sources = [
    { startTime: 0, endTime: 10 },
    { startTime: 10, endTime: 20 }
  ]

  it("places each file's peaks on its range of the global time line", () => {
    expect(
      globalPeaks(
        sources,
        [
          [0.5, 0.25],
          [1, 0.5]
        ],
        20,
        4
      )
    ).toEqual([0.5, 0.25, 1, 0.5])
  })

  it('scales the loudest to 1 and leaves files without peaks silent', () => {
    expect(globalPeaks(sources, [[0.25, 0.5], null], 20, 4)).toEqual([0.5, 1, 0, 0])
  })

  it('stretches fewer peaks than buckets', () => {
    expect(globalPeaks([{ startTime: 0, endTime: 10 }], [[1, 0.5]], 10, 4)).toEqual([
      1, 1, 0.5, 0.5
    ])
  })

  it('is null while no file has peaks or the time line is empty', () => {
    expect(globalPeaks(sources, [null, null], 20, 4)).toBeNull()
    expect(globalPeaks(sources, [[1], [1]], 0, 4)).toBeNull()
    expect(globalPeaks([], [], 20, 4)).toBeNull()
  })
})

describe('sourceWaveform', () => {
  it("takes the analysis's waveform for a file above the decode limit, without fetching the audio", async () => {
    vi.mocked(getJobAudioUrl).mockClear()
    vi.mocked(getJobPeaks).mockResolvedValueOnce({
      peaks: btoa(String.fromCharCode(0, 255)),
      perSecond: 20,
      duration: 2
    } as TranscriptionJobPeaks)
    const result = await sourceWaveform('big-job', TRANSCRIPTION_WAVEFORM_DECODE_MAX_BYTES + 1)
    expect(getJobAudioUrl).not.toHaveBeenCalled()
    expect(result?.duration).toBe(2)
    expect(Math.max(...result!.peaks)).toBe(1)
  })

  it('asks again for a waveform it did not find', async () => {
    vi.mocked(getJobAudioUrl).mockRejectedValue(new Error('offline'))
    vi.mocked(getJobPeaks).mockResolvedValue(null)
    expect(await sourceWaveform('missing-job', 10)).toBeNull()
    expect(await sourceWaveform('missing-job', 10)).toBeNull()
    expect(getJobAudioUrl).toHaveBeenCalledTimes(2)
  })
})
