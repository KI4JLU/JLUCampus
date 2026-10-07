import { describe, expect, it, vi } from 'vitest'
import { TRANSCRIPTION_WAVEFORM_DECODE_MAX_BYTES } from '@justcampus/shared'
import { getJobPeaks } from '../api'
import { loadTimePeaks, peaksBetween, timePeaksOf } from './window-peaks'

vi.mock('../api', () => ({ getJobPeaks: vi.fn() }))

describe('timePeaksOf', () => {
  it('takes the loudest sample per bucket of time, scaled to the loudest', () => {
    // 1 second at 100 Hz, 20 peaks per second: buckets of 5 samples.
    const channel = new Float32Array(100)
    channel[2] = 0.5
    channel[7] = -1
    channel[99] = 0.25
    const peaks = timePeaksOf(channel, 100, 20)
    expect(peaks).toHaveLength(20)
    expect(peaks[0]).toBeCloseTo(0.5)
    expect(peaks[1]).toBeCloseTo(1)
    expect(peaks[19]).toBeCloseTo(0.25)
    expect(peaks[10]).toBe(0)
  })

  it('stays finite for silence', () => {
    expect(timePeaksOf(new Float32Array(10), 10, 5)).toEqual([0, 0, 0, 0, 0])
  })
})

describe('peaksBetween', () => {
  it('slices the peaks of a time range, at least one', () => {
    const data = { peaks: [0, 0.1, 0.2, 0.3, 0.4, 0.5], duration: 3 }
    expect(peaksBetween(data, 0.5, 1.5, 2)).toEqual([0.1, 0.2])
    expect(peaksBetween(data, 10, 12, 2)).toEqual([0])
  })
})

describe('the editor’s peaks of large files (T-19)', () => {
  const wav = { size: 1024, type: 'audio/wav', name: 'interview.wav', duration: null }

  it('takes the server’s waveform for a local file above the decode limit', async () => {
    vi.mocked(getJobPeaks).mockResolvedValueOnce({
      perSecond: 20,
      duration: 0.1,
      peaks: btoa(String.fromCharCode(0, 255))
    })
    // A blob claiming its size; its bytes are never read.
    const large = { size: TRANSCRIPTION_WAVEFORM_DECODE_MAX_BYTES + 1 } as Blob
    expect(await loadTimePeaks({ blob: large, jobId: 'job-editor', duration: null })).toEqual({
      peaks: [0, 1],
      duration: 0.1
    })
    expect(await loadTimePeaks({ blob: large, jobId: null, duration: null })).toBeNull()
  })

  it('waits for a restored job’s URL only when the server has no waveform', async () => {
    vi.mocked(getJobPeaks).mockResolvedValueOnce(null)
    expect(await loadTimePeaks({ ...wav, jobId: 'job-restored', url: null })).toBeNull()
    vi.mocked(getJobPeaks).mockResolvedValueOnce({
      perSecond: 20,
      duration: 0.05,
      peaks: btoa(String.fromCharCode(128))
    })
    expect(await loadTimePeaks({ ...wav, jobId: 'job-restored-2', url: null })).toEqual({
      peaks: [128 / 255],
      duration: 0.05
    })
  })

  it('does not download a restored WebM of unknown or long duration', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const meeting = { size: 1024, type: 'audio/webm', name: 'meeting.webm' }
    vi.mocked(getJobPeaks).mockResolvedValue(null)
    const url = 'https://storage.example/meeting.webm'
    expect(
      await loadTimePeaks({ ...meeting, jobId: 'job-meeting', url, duration: null })
    ).toBeNull()
    expect(await loadTimePeaks({ ...meeting, jobId: 'job-long', url, duration: 3600 })).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
    vi.mocked(getJobPeaks).mockReset()
    vi.unstubAllGlobals()
  })
})
