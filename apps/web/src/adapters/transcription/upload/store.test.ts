import { describe, expect, it, vi, type Mock } from 'vitest'
import type {
  TranscriptionJob,
  TranscriptionJobStatus,
  TranscriptionResult,
  TranscriptionTranscript,
  TranscriptionTranscriptCreate
} from '@justcampus/shared'
import { ApiRequestError } from '@/lib/api'
import { UploadError } from '../api'
import { fakeEvents, type FakeEvents } from '../fake-events'
import { allFiles, findFile, handoverGroupIndex, serverWaveform, type QueueFile } from './queue'
import { UploadQueue, type SignedUpload, type UploadApi, type UploadQueueOptions } from './store'

const NOW = '2026-10-04T10:00:00.000Z'

function job(id: string, change: Partial<TranscriptionJob> = {}): TranscriptionJob {
  return {
    id,
    filename: `${id}.wav`,
    size: 10,
    mimeType: 'audio/wav',
    duration: 12,
    groupId: null,
    groupOrder: 0,
    settings: { language: 'auto', speakerCount: 'auto', llmCorrection: true },
    status: 'uploading',
    progress: null,
    speakers: [],
    mapping: {},
    snippets: [],
    colors: {},
    error: null,
    result: null,
    transcriptId: null,
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: null,
    ...change
  }
}

const SPEAKERS: TranscriptionJob['speakers'] = [
  {
    id: 'SPEAKER_00',
    index: 0,
    label: 'Stimme 1',
    start: 0.03,
    end: 5.03,
    samples: [{ id: 's0', start: 0.03, end: 5.03 }]
  }
]

function result(text: string, end: number): TranscriptionResult {
  return {
    text,
    language: 'de',
    duration: end,
    segments: [{ id: 1, start: 0, end, text, speaker: 'Test speaker', redactions: [] }],
    words: [],
    model: 'jlu/whisper-1',
    provider: 'KI@JLU'
  }
}

function transcript(
  input: TranscriptionTranscriptCreate,
  id = 'transcript-1'
): TranscriptionTranscript {
  return {
    id,
    title: input.title,
    subtitle: null,
    subtitleSource: null,
    language: input.language,
    duration: input.duration,
    originalFilename: null,
    model: null,
    provider: null,
    fileSize: null,
    text: '',
    segments: [],
    words: [],
    sourceFiles: [],
    speakerColors: {},
    summaryTemplateId: null,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: null
  }
}

/** Every endpoint as a mock, typed as the queue calls it. */
type FakeApi = { [Name in keyof UploadApi]: Mock<UploadApi[Name]> }

interface FakeServer {
  api: FakeApi
  events: FakeEvents
  /**
   * Sets the states a job goes through: the first one at once, each next one a moment later. Every
   * change is sent as a `job` event without the result; `getJob` answers the current state.
   */
  script: (id: string, ...steps: Partial<TranscriptionJob>[]) => void
}

/** A stand-in server and its stream; a new script of a job replaces the rest of its old one. */
function server(): FakeServer {
  const events = fakeEvents()
  const states = new Map<string, TranscriptionJob>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  let created = 0
  const script = (id: string, ...steps: Partial<TranscriptionJob>[]): void => {
    clearTimeout(timers.get(id))
    const pending = steps.map((step) => job(id, step))
    const next = (): void => {
      const state = pending.shift()
      if (!state) return
      states.set(id, state)
      events.emit({ type: 'job', data: { ...state, result: null } })
      if (pending.length > 0) timers.set(id, setTimeout(next, 1))
    }
    next()
  }
  const api: FakeApi = {
    listJobs: vi.fn<UploadApi['listJobs']>(async () => []),
    createJob: vi.fn<UploadApi['createJob']>(async (input) => {
      const id = `job-${++created}`
      return {
        job: job(id, { filename: input.filename }),
        upload: { url: `http://storage.test/${id}`, method: 'PUT', headers: {}, expiresAt: NOW }
      }
    }),
    getJob: vi.fn<UploadApi['getJob']>(async (id) => {
      const state = states.get(id)
      if (!state) throw new ApiRequestError(404, null)
      return state
    }),
    analyzeJob: vi.fn<UploadApi['analyzeJob']>(async (id) =>
      job(id, { status: 'analyzingQueued' })
    ),
    dispatchJob: vi.fn<UploadApi['dispatchJob']>(async (id) =>
      job(id, { status: 'preprocessing' })
    ),
    deleteJob: vi.fn<UploadApi['deleteJob']>(async () => undefined),
    createTranscript: vi.fn<UploadApi['createTranscript']>(async (input) => transcript(input)),
    getTranscript: vi.fn<UploadApi['getTranscript']>(),
    patchTranscript: vi.fn<UploadApi['patchTranscript']>()
  }
  return { api, events, script }
}

function makeQueue(
  api: UploadApi,
  events: FakeEvents,
  upload: SignedUpload = async () => undefined,
  extra: Partial<UploadQueueOptions> = {}
): UploadQueue {
  const queue = new UploadQueue({
    api,
    upload,
    events,
    settings: { language: 'de', speakerCount: 'multi', llmCorrection: false },
    labels: { autoLabel: (n) => `Voice ${n}`, sampleLabel: (n) => `Sample ${n}` },
    measureDuration: async () => 12,
    syncRetryMs: 1,
    creepMs: 10_000,
    ...extra
  })
  return queue
}

function wav(name: string): File {
  return new File([new Uint8Array(10)], name, { type: 'audio/wav', lastModified: 1 })
}

/** Waits until `check` holds, failing after a second. */
async function until(check: () => boolean): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > 1000) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

const rows = (queue: UploadQueue): QueueFile[] => allFiles(queue.getSnapshot().groups)
const row = (queue: UploadQueue, name: string): QueueFile =>
  rows(queue).find((file) => file.name === name)!

describe('UploadQueue: upload and analysis (T-10, T-16, T-17)', () => {
  it('creates the job, uploads, analyses and names the voices', async () => {
    const { api, events, script } = server()
    script(
      'job-1',
      { status: 'analyzingQueued' },
      { status: 'analyzing' },
      { status: 'analyzed', speakers: SPEAKERS }
    )
    const upload = vi.fn(
      async (_target: unknown, _body: Blob, options: { onProgress?: (f: number) => void }) => {
        options.onProgress?.(0.5)
      }
    )
    const queue = makeQueue(api, events, upload)
    queue.addFiles([wav('a.wav')])
    await until(() => row(queue, 'a.wav').phase === 'ready')
    const file = row(queue, 'a.wav')
    expect(api.createJob).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: 'a.wav',
        size: 10,
        language: 'de',
        speakerCount: 'multi'
      })
    )
    expect(upload).toHaveBeenCalledOnce()
    // The speaker count chosen now goes along, as it may have changed since the upload (T-09).
    expect(api.analyzeJob).toHaveBeenCalledWith('job-1', { duration: 12, speakerCount: 'multi' })
    expect(file).toMatchObject({
      jobId: 'job-1',
      uploaded: true,
      progress: 100,
      status: 'readyForTranscription',
      tone: 'ready',
      duration: 12
    })
    expect(file.voices?.map((voice) => [voice.id, voice.name])).toEqual([['SPEAKER_00', 'Voice 1']])
  })

  it('shows a failed analysis with the server detail', async () => {
    const { api, events, script } = server()
    script('job-1', {
      status: 'failed',
      error: { code: 'diarization_failed', message: 'Diarization-Server antwortete mit Status 415' }
    })
    const queue = makeQueue(api, events)
    queue.addFiles([wav('bad.wav')])
    await until(() => row(queue, 'bad.wav').phase === 'analysisFailed')
    expect(row(queue, 'bad.wav')).toMatchObject({
      tone: 'error',
      status: 'failed',
      progress: 100,
      error: { key: 'analysisError', message: 'Diarization-Server antwortete mit Status 415' }
    })
  })

  it('notes an unavailable diariser and a skipped correction without failing', async () => {
    const { api, events, script } = server()
    script('job-1', {
      status: 'analyzed',
      speakers: SPEAKERS,
      error: { code: 'diarization_failed', message: 'Sprechererkennung nicht verfügbar (403).' }
    })
    const queue = makeQueue(api, events)
    queue.addFiles([wav('a.wav')])
    await until(() => row(queue, 'a.wav').phase === 'ready')
    expect(row(queue, 'a.wav')).toMatchObject({
      status: 'readyForTranscription',
      tone: 'ready',
      error: null,
      notice: 'diarizationUnavailable'
    })

    script('job-1', {
      status: 'completed',
      result: result('A', 5),
      error: { code: 'correction_failed', message: 'KI-Korrektur übersprungen (500).' }
    })
    await queue.start()
    expect(row(queue, 'a.wav')).toMatchObject({ error: null, notice: 'correctionSkipped' })
  })

  it('still shows the server waveform after the speaker analysis failed (T-12)', async () => {
    const { api, events, script } = server()
    script('job-1', {
      status: 'failed',
      error: { code: 'analysis_failed', message: 'Sprecheranalyse fehlgeschlagen (503)' }
    })
    const queue = makeQueue(api, events)
    queue.addFiles([wav('large.wav')])
    await until(() => row(queue, 'large.wav').phase === 'analysisFailed')
    const file = row(queue, 'large.wav')
    expect(file).toMatchObject({ uploaded: true, voices: null })
    // The peaks were stored after normalising, before the diariser failed.
    expect(serverWaveform(file)).toEqual({ jobId: 'job-1', revision: 'analysisFailed' })
  })

  it('tells storage errors and session errors apart', async () => {
    const { api, events } = server()
    const queue = makeQueue(
      api,
      events,
      vi.fn(async () => {
        throw new UploadError('status', 403)
      })
    )
    queue.addFiles([wav('a.wav')])
    await until(() => row(queue, 'a.wav').phase === 'analysisFailed')
    expect(row(queue, 'a.wav').error).toEqual({ key: 's3UploadFailed', status: 403 })
    expect(api.analyzeJob).not.toHaveBeenCalled()

    api.createJob.mockRejectedValueOnce(new ApiRequestError(429, null))
    queue.addFiles([wav('b.wav')])
    await until(() => row(queue, 'b.wav').phase === 'analysisFailed')
    expect(row(queue, 'b.wav').error).toMatchObject({ key: 'uploadSessionFailed' })
  })
})

describe('UploadQueue: following jobs by their events (T-10, T-11)', () => {
  it('shows the states events report and fetches a completed job once for its result', async () => {
    const { api, events, script } = server()
    script('job-1', { status: 'analyzed', speakers: SPEAKERS })
    const queue = makeQueue(api, events)
    queue.addFiles([wav('a.wav')])
    await until(() => row(queue, 'a.wav').phase === 'ready')
    api.getJob.mockClear()

    const started = queue.start()
    // One fetch once the flow listens, as events may have been missed before.
    await until(() => api.getJob.mock.calls.length === 1)
    script('job-1', { status: 'transcribing', progress: null })
    await until(() => row(queue, 'a.wav').status === 'preparing')
    expect(row(queue, 'a.wav').progress).toBe(40)
    expect(api.getJob).toHaveBeenCalledTimes(1)

    script('job-1', { status: 'completed', result: result('A', 5) })
    expect(await started).toMatchObject({ failed: false })
    // The event has no result: one more fetch got it.
    expect(api.getJob).toHaveBeenCalledTimes(2)
    expect(row(queue, 'a.wav').result?.text).toBe('A')
    expect(events.subscribers).toBe(0)
  })

  it('drops a fetch the stream reported a newer state during, and fetches the result', async () => {
    const { api, events, script } = server()
    script('job-1', { status: 'analyzed', speakers: SPEAKERS })
    const queue = makeQueue(api, events)
    queue.addFiles([wav('a.wav')])
    await until(() => row(queue, 'a.wav').phase === 'ready')
    api.getJob.mockClear()
    let answer: (state: TranscriptionJob) => void = () => undefined
    api.getJob.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve
        })
    )

    const started = queue.start()
    await until(() => api.getJob.mock.calls.length === 1)
    // Completed while the fetch is under way, which then answers with an older state.
    script('job-1', { status: 'completed', result: result('A', 5) })
    answer(job('job-1', { status: 'failed', error: { code: 'asr_failed', message: 'alt' } }))
    expect(await started).toMatchObject({ failed: false })
    expect(api.getJob).toHaveBeenCalledTimes(2)
    expect(row(queue, 'a.wav').result?.text).toBe('A')
    expect(events.subscribers).toBe(0)
  })

  it('keeps a state reported before a fetch that then fails, and goes on with it', async () => {
    const { api, events, script } = server()
    script('job-1', { status: 'analyzing' })
    let answer: (state: TranscriptionJob) => void = () => undefined
    api.getJob.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve
        })
    )
    const queue = makeQueue(api, events)
    queue.addFiles([wav('a.wav')])
    await until(() => api.getJob.mock.calls.length === 1)
    // The stream reconnects and reports the analysis done while the first fetch is under way.
    api.getJob.mockRejectedValue(new Error('offline'))
    events.setOpen(true)
    events.emit({ type: 'job', data: job('job-1', { status: 'analyzed', speakers: SPEAKERS }) })
    answer(job('job-1', { status: 'analyzing' }))
    await until(() => row(queue, 'a.wav').phase !== 'analyzing')
    expect(row(queue, 'a.wav')).toMatchObject({ phase: 'ready', status: 'readyForTranscription' })
    expect(events.subscribers).toBe(0)
  })

  it('takes a state reported during a failed fetch before counting the failure', async () => {
    const { api, events, script } = server()
    script('job-1', { status: 'analyzing' })
    let fail: (error: Error) => void = () => undefined
    api.getJob.mockImplementation(() =>
      api.getJob.mock.calls.length < 5
        ? Promise.reject(new Error('offline'))
        : new Promise((_, reject) => {
            fail = reject
          })
    )
    const queue = makeQueue(api, events)
    queue.addFiles([wav('a.wav')])
    // Four failures in a row; the fifth fetch is under way when the analysis is reported done.
    await until(() => api.getJob.mock.calls.length === 5)
    events.emit({ type: 'job', data: job('job-1', { status: 'analyzed', speakers: SPEAKERS }) })
    fail(new Error('offline'))
    await until(() => row(queue, 'a.wav').phase !== 'analyzing')
    expect(row(queue, 'a.wav')).toMatchObject({ phase: 'ready', status: 'readyForTranscription' })
    expect(api.getJob).toHaveBeenCalledTimes(5)
    expect(events.subscribers).toBe(0)
  })

  it('fetches the result of a job reported completed during a failed fetch', async () => {
    const { api, events, script } = server()
    script('job-1', { status: 'analyzed', speakers: SPEAKERS })
    const queue = makeQueue(api, events)
    queue.addFiles([wav('a.wav')])
    await until(() => row(queue, 'a.wav').phase === 'ready')
    script('job-1', { status: 'transcribing' })
    let fail: (error: Error) => void = () => undefined
    api.getJob.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject
        })
    )
    const started = queue.start()
    await until(() => events.subscribers === 1)
    script('job-1', { status: 'completed', result: result('A', 5) })
    fail(new Error('offline'))
    expect(await started).toMatchObject({ failed: false })
    expect(row(queue, 'a.wav').result?.text).toBe('A')
  })

  it('catches up after the stream reconnects', async () => {
    const { api, events, script } = server()
    script('job-1', { status: 'analyzing' })
    const queue = makeQueue(api, events)
    queue.addFiles([wav('a.wav')])
    await until(() => row(queue, 'a.wav').status === 'analyzingSpeakers')
    events.setOpen(false)
    // Missed while the stream is down.
    script('job-1', { status: 'analyzed', speakers: SPEAKERS })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(row(queue, 'a.wav').phase).toBe('analyzing')
    events.setOpen(true)
    await until(() => row(queue, 'a.wav').phase === 'ready')
    queue.dispose()
  })

  it('fails a file whose job was removed on the server', async () => {
    const { api, events, script } = server()
    script('job-1', { status: 'analyzing' })
    const queue = makeQueue(api, events)
    queue.addFiles([wav('a.wav')])
    await until(() => row(queue, 'a.wav').status === 'analyzingSpeakers')
    events.emit({ type: 'jobRemoved', data: { id: 'job-1' } })
    await until(() => row(queue, 'a.wav').phase === 'analysisFailed')
    expect(row(queue, 'a.wav').error).toEqual({ key: 'analysisError', message: null })
    expect(events.subscribers).toBe(0)
  })

  it('tries a failed fetch again and gives up after five in a row', async () => {
    const { api, events, script } = server()
    script('job-1', { status: 'analyzed', speakers: SPEAKERS })
    api.getJob.mockRejectedValueOnce(new Error('offline'))
    const queue = makeQueue(api, events)
    queue.addFiles([wav('a.wav')])
    await until(() => row(queue, 'a.wav').phase === 'ready')
    expect(api.getJob).toHaveBeenCalledTimes(2)

    api.getJob.mockClear()
    api.getJob.mockRejectedValue(new Error('offline'))
    expect(await queue.reanalyze(row(queue, 'a.wav').id, { keepVoices: true })).toEqual({
      ok: false,
      message: 'offline'
    })
    expect(api.getJob).toHaveBeenCalledTimes(5)
  })

  it('stops listening when the page goes', async () => {
    const { api, events, script } = server()
    script('job-1', { status: 'analyzing' })
    const queue = makeQueue(api, events)
    queue.addFiles([wav('a.wav')])
    await until(() => events.subscribers === 1)
    queue.dispose()
    await until(() => events.subscribers === 0)
  })
})

describe('UploadQueue: start, merge and save (T-13, T-14)', () => {
  it('saves each group once all its files succeeded, and retries only what failed', async () => {
    const { api, events, script } = server()
    for (const id of ['job-1', 'job-2', 'job-3']) {
      script(id, { status: 'analyzed', speakers: SPEAKERS })
    }
    const queue = makeQueue(api, events)
    queue.addFiles([wav('a.wav'), wav('b.wav')], 0)
    queue.addFiles([wav('c.wav')], 1)
    await until(() => rows(queue).every((file) => file.phase === 'ready'))

    script('job-1', { status: 'transcribing' }, { status: 'completed', result: result('A', 5) })
    script('job-2', {
      status: 'failed',
      error: { code: 'asr_failed', message: 'boom' }
    })
    script('job-3', { status: 'completed', result: result('C', 3) })
    const first = await queue.start()

    expect(first).toEqual({ status: 'done', savedIds: ['transcript-1'], failed: true })
    expect(api.dispatchJob).toHaveBeenCalledTimes(3)
    expect(api.dispatchJob).toHaveBeenCalledWith('job-1', {
      mapping: { SPEAKER_00: 'Voice 1' },
      snippets: [{ id: 'SPEAKER_00', name: 'Voice 1', start: 0.03, end: 5.03 }],
      colors: { SPEAKER_00: 1 },
      speakerCount: 'multi',
      llmCorrection: false,
      language: 'de'
    })
    // Only the second group was saved; the first keeps its finished file for the retry.
    expect(api.createTranscript).toHaveBeenCalledOnce()
    expect(api.createTranscript.mock.calls[0]?.[0]).toMatchObject({ jobIds: ['job-3'] })
    const groups = queue.getSnapshot().groups
    expect(groups[0]?.saved).toBeNull()
    expect(groups[1]?.saved).toMatchObject({ id: 'transcript-1' })
    expect(row(queue, 'a.wav').result?.text).toBe('A')
    expect(row(queue, 'b.wav')).toMatchObject({
      phase: 'failed',
      error: { key: 'transcriptionError', message: 'boom' }
    })

    // The retry dispatches only the failed job again, without a new analysis, and saves the group.
    const analyses = api.analyzeJob.mock.calls.length
    api.dispatchJob.mockImplementationOnce(async (id: string) => {
      script(id, { status: 'completed', result: result('B', 4) })
      return job(id, { status: 'preprocessing' })
    })
    api.createTranscript.mockImplementationOnce(async (input) => transcript(input, 'transcript-2'))
    const second = await queue.start()

    expect(second).toEqual({ status: 'done', savedIds: ['transcript-2'], failed: false })
    expect(api.dispatchJob).toHaveBeenCalledTimes(4)
    expect(api.dispatchJob.mock.calls[3]?.[0]).toBe('job-2')
    expect(api.analyzeJob).toHaveBeenCalledTimes(analyses)
    const saved = api.createTranscript.mock.calls[1]?.[0]
    expect(saved).toMatchObject({ title: 'Transcript 1', jobIds: ['job-1', 'job-2'], duration: 9 })
    expect(saved?.segments.map((segment) => [segment.start, segment.end])).toEqual([
      [0, 5],
      [5, 9]
    ])
    expect(saved?.sourceFiles.map((source) => [source.startTime, source.endTime])).toEqual([
      [0, 5],
      [5, 9]
    ])
    // As in kiChat, a start's save leaves the rows' status: reused or freshly transcribed.
    expect(row(queue, 'a.wav').status).toBe('readyFromCache')
    expect(row(queue, 'b.wav').status).toBe('transcriptionComplete')
    expect(row(queue, 'c.wav').status).toBe('transcriptionComplete')
  })

  it('keeps voices added by hand when a failed transcription is retried (T-20)', async () => {
    const { api, events, script } = server()
    script('job-1', { status: 'analyzed', speakers: SPEAKERS })
    const queue = makeQueue(api, events)
    queue.addFiles([wav('a.wav')])
    await until(() => row(queue, 'a.wav').phase === 'ready')
    const fileId = row(queue, 'a.wav').id
    const analysed = row(queue, 'a.wav').voices!
    const bob = {
      id: 'manual_1',
      manual: true,
      name: 'Bob',
      colorId: 7 as const,
      start: null,
      end: null,
      fallback: null,
      samples: [{ key: 'local-1', label: 'Sample 1', start: 5, end: 10 }]
    }
    queue.saveVoices(fileId, [...analysed, bob])

    script('job-1', { status: 'failed', error: { code: 'asr_failed', message: 'boom' } })
    expect(await queue.start()).toMatchObject({ failed: true })
    const bobDispatched = {
      mapping: expect.objectContaining({ manual_1: 'Bob' }),
      snippets: expect.arrayContaining([{ id: 'manual_1', name: 'Bob', start: 5, end: 10 }]),
      colors: expect.objectContaining({ manual_1: 7 })
    }
    expect(api.dispatchJob).toHaveBeenLastCalledWith(
      'job-1',
      expect.objectContaining(bobDispatched)
    )

    // The server refuses the dispatch (its analysis failed): analysed again, Bob stays.
    api.dispatchJob.mockRejectedValueOnce(new ApiRequestError(409, null))
    api.analyzeJob.mockImplementationOnce(async (id: string) => {
      script(id, { status: 'analyzed', speakers: SPEAKERS })
      return job(id, { status: 'analyzingQueued' })
    })
    api.dispatchJob.mockImplementationOnce(async (id: string) => {
      script(id, { status: 'completed', result: result('A', 5) })
      return job(id, { status: 'preprocessing' })
    })
    expect(await queue.start()).toMatchObject({ failed: false })
    expect(api.dispatchJob).toHaveBeenLastCalledWith(
      'job-1',
      expect.objectContaining(bobDispatched)
    )
    expect(row(queue, 'a.wav').voices?.map((voice) => voice.name)).toEqual(['Voice 1', 'Bob'])
  })

  it('reports an empty queue', async () => {
    const { api, events } = server()
    const queue = makeQueue(api, events)
    expect(await queue.start()).toMatchObject({ status: 'empty' })
  })
})

describe('UploadQueue: removing (T-08)', () => {
  it('removes a row only once its job is deleted', async () => {
    const { api, events, script } = server()
    script('job-1', { status: 'analyzed', speakers: [] })
    const queue = makeQueue(api, events)
    queue.addFiles([wav('a.wav')])
    await until(() => row(queue, 'a.wav')?.phase === 'ready')
    const id = row(queue, 'a.wav').id
    expect(queue.removalDeletesJob(id)).toBe(true)

    api.deleteJob.mockRejectedValueOnce(new Error('offline'))
    expect(await queue.removeFile(id)).toBe(false)
    expect(rows(queue)).toHaveLength(1)

    expect(await queue.removeFile(id)).toBe(true)
    expect(api.deleteJob).toHaveBeenLastCalledWith('job-1')
    expect(queue.getSnapshot().groups).toEqual([])
  })

  it('counts a job the server no longer has as deleted', async () => {
    const { api, events, script } = server()
    script('job-1', { status: 'analyzed', speakers: [] })
    const queue = makeQueue(api, events)
    queue.addFiles([wav('a.wav')])
    await until(() => row(queue, 'a.wav')?.phase === 'ready')
    api.deleteJob.mockRejectedValueOnce(new ApiRequestError(404, null))
    expect(await queue.removeFile(row(queue, 'a.wav').id)).toBe(true)
    expect(rows(queue)).toEqual([])
  })

  it('keeps a group with the files whose jobs could not be deleted', async () => {
    const { api, events, script } = server()
    script('job-1', { status: 'analyzed' })
    script('job-2', { status: 'analyzed' })
    const queue = makeQueue(api, events)
    queue.addFiles([wav('a.wav'), wav('b.wav')])
    await until(() => rows(queue).every((file) => file.phase === 'ready'))
    api.deleteJob.mockImplementation(async (id: string) => {
      if (id === 'job-2') throw new Error('offline')
    })
    const groupId = queue.getSnapshot().groups[0]!.id
    expect(await queue.removeGroup(groupId)).toBe(false)
    expect(rows(queue).map((file) => file.name)).toEqual(['b.wav'])
  })
})

describe('UploadQueue: removing restored and analysing files (T-08, T-15)', () => {
  /** A queue with one job restored while its voices are analysed, as after a reload. */
  async function restoredAnalysing(): Promise<{ server: FakeServer; queue: UploadQueue }> {
    const server_ = server()
    const listed = job('job-x', { status: 'analyzing', filename: 'talk.wav.m4a' })
    server_.api.listJobs.mockResolvedValue([listed])
    server_.script('job-x', { status: 'analyzing' })
    // The server answers the deletion and then reports the job gone, as its stream does.
    server_.api.deleteJob.mockImplementation(async (id) => {
      server_.api.listJobs.mockResolvedValue([])
      queueMicrotask(() => server_.events.emit({ type: 'jobRemoved', data: { id } }))
    })
    const queue = makeQueue(server_.api, server_.events)
    queue.attach()
    queue.showView('upload')
    await until(() => row(queue, 'talk.wav.m4a')?.status === 'analyzingSpeakers')
    return { server: server_, queue }
  }

  it('deletes the job and the folder when the folder is deleted', async () => {
    const { server: fake, queue } = await restoredAnalysing()
    const groupId = queue.getSnapshot().groups[0]!.id
    expect(await queue.removeGroup(groupId)).toBe(true)
    expect(fake.api.deleteJob).toHaveBeenCalledWith('job-x')
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(queue.getSnapshot().groups).toEqual([])
    // Opening the upload view again brings nothing back.
    queue.showView('upload')
    await queue.whenRestored()
    expect(queue.getSnapshot().groups).toEqual([])
    queue.dispose()
  })

  it('deletes the job and the folder it leaves empty when its file is removed', async () => {
    const { server: fake, queue } = await restoredAnalysing()
    queue.addGroup()
    expect(await queue.removeFile(row(queue, 'talk.wav.m4a').id)).toBe(true)
    expect(fake.api.deleteJob).toHaveBeenCalledWith('job-x')
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(rows(queue)).toEqual([])
    // Without files the queue is empty again, the page back at its drop area.
    expect(queue.getSnapshot().groups).toEqual([])
    queue.dispose()
  })

  it('keeps a folder just added when another folder loses its last file', async () => {
    const { api, events, script } = server()
    script('job-1', { status: 'analyzed', speakers: [] })
    script('job-2', { status: 'analyzed', speakers: [] })
    const queue = makeQueue(api, events)
    queue.addFiles([wav('a.wav')])
    queue.addGroup()
    queue.addFiles([wav('b.wav')], 1)
    await until(() => rows(queue).every((file) => file.phase === 'ready'))
    queue.addGroup()

    expect(await queue.removeFile(row(queue, 'b.wav').id)).toBe(true)
    const groups = queue.getSnapshot().groups
    expect(groups.map((group) => group.name)).toEqual(['Transcript 1', 'Transcript 2'])
    expect(groups.map((group) => group.files.length)).toEqual([1, 0])
    queue.dispose()
  })

  it('does not bring back a job removed while a listing of the jobs was under way', async () => {
    const { api, events, script } = server()
    script('job-1', { status: 'analyzed', speakers: [] })
    const queue = makeQueue(api, events)
    queue.attach()
    queue.addFiles([wav('a.wav')])
    await until(() => row(queue, 'a.wav')?.phase === 'ready')

    // The listing answers with the job as it was before the removal.
    let answer: (jobs: TranscriptionJob[]) => void = () => undefined
    api.listJobs.mockImplementation(() => new Promise((resolve) => (answer = resolve)))
    queue.showView('upload')
    await until(() => api.listJobs.mock.calls.length === 1)
    expect(await queue.removeFile(row(queue, 'a.wav').id)).toBe(true)
    answer([job('job-1', { status: 'analyzed', speakers: SPEAKERS, filename: 'a.wav' })])
    await queue.whenRestored()

    expect(queue.getSnapshot().groups).toEqual([])
    queue.dispose()
  })
})

describe('UploadQueue: telling when handed-over files are stored (T-58)', () => {
  it('reports stored once storage has the bytes, before the analysis starts', async () => {
    const { api, events, script } = server()
    script('job-1', { status: 'analyzed', speakers: SPEAKERS })
    const queue = makeQueue(api, events)
    const onStored = vi.fn()
    const take = wav('take.webm')
    queue.addGroupOfFiles([take], { onStored })
    await until(() => row(queue, 'take.webm').phase === 'ready')
    expect(onStored.mock.calls).toEqual([[take]])
    expect(onStored.mock.invocationCallOrder[0]).toBeLessThan(
      api.analyzeJob.mock.invocationCallOrder[0]!
    )
    queue.dispose()
  })

  it('says nothing of a failed upload, and reports the retry that stores it', async () => {
    const { api, events } = server()
    const upload = vi.fn<SignedUpload>(async () => {
      throw new UploadError('status', 500)
    })
    const queue = makeQueue(api, events, upload)
    const onStored = vi.fn()
    const take = wav('take.webm')
    queue.addGroupOfFiles([take], { onStored })
    await until(() => row(queue, 'take.webm').phase === 'analysisFailed')
    expect(onStored).not.toHaveBeenCalled()

    upload.mockResolvedValueOnce(undefined)
    void queue.retry(row(queue, 'take.webm').id)
    await until(() => onStored.mock.calls.length === 1)
    expect(onStored).toHaveBeenCalledWith(take)
    queue.dispose()
  })

  it('never reports a file removed during its upload', async () => {
    const { api, events } = server()
    let uploading = false
    const upload: SignedUpload = (_target, _body, options) =>
      new Promise((_resolve, reject) => {
        uploading = true
        options.signal?.addEventListener('abort', () => reject(new UploadError('aborted', null)))
      })
    const queue = makeQueue(api, events, upload)
    const onStored = vi.fn()
    queue.addGroupOfFiles([wav('a.webm')], { onStored })
    await until(() => uploading)
    expect(await queue.removeFile(row(queue, 'a.webm').id)).toBe(true)
    await Promise.resolve()
    expect(onStored).not.toHaveBeenCalled()
    queue.dispose()
  })
})

describe('UploadQueue: lengths of handed-over files (T-58)', () => {
  it('takes a known length as measured and measures the others', async () => {
    const { api, events } = server()
    const queue = makeQueue(api, events)
    const take = wav('take.webm')
    const durations = new Map([[take, 23]])
    queue.addGroupOfFiles([take, wav('other.webm')], { durations })
    expect(row(queue, 'take.webm').duration).toBe(23)
    await until(() => row(queue, 'other.webm').duration === 12)
    expect(row(queue, 'take.webm').duration).toBe(23)
    queue.dispose()
  })
})

describe('UploadQueue: restoring active jobs (T-15)', () => {
  it('restores each job as its own group and saves finished transcriptions', async () => {
    const { api, events, script } = server()
    const statuses: [string, TranscriptionJobStatus][] = [
      ['job-a', 'analyzed'],
      ['job-b', 'transcribing'],
      ['job-c', 'failed']
    ]
    api.listJobs.mockResolvedValue(
      statuses.map(([id, status]) =>
        job(id, { status, speakers: status === 'failed' ? [] : SPEAKERS, size: 500 })
      )
    )
    script('job-b', { status: 'completed', result: result('B', 4) })
    const queue = makeQueue(api, events)
    queue.attach()
    queue.showView('upload')
    await until(() => rows(queue).length === 3 && Boolean(queue.getSnapshot().groups[1]?.saved))

    const groups = queue.getSnapshot().groups
    expect(groups.map((group) => group.name)).toEqual(['job-a', 'job-b', 'job-c'])
    expect(findFile(groups, rows(queue)[0]!.id)?.file).toMatchObject({
      restored: true,
      file: null,
      size: 500,
      phase: 'ready'
    })
    expect(api.dispatchJob).not.toHaveBeenCalled()
    expect(api.createTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'job-b', jobIds: ['job-b'] })
    )
    // A restored job saved by itself reads 'Fertig', as after kiChat's re-render.
    expect(groups[1]?.files[0]).toMatchObject({ phase: 'completed', status: 'done' })
    expect(row(queue, 'job-c.wav')).toMatchObject({ phase: 'analysisFailed', tone: 'error' })

    // A second restore adds nothing already in the queue.
    await queue.restoreActiveJobs()
    expect(rows(queue)).toHaveLength(3)
    queue.dispose()
  })

  it('lists again when the page left before the listing answered', async () => {
    const { api, events } = server()
    api.listJobs.mockImplementation(
      (signal) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve([job('job-a', { status: 'analyzed' })]), 5)
          signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(new Error('aborted'))
          })
        })
    )
    const queue = makeQueue(api, events)
    // As React's StrictMode mounts at the upload view: attach and report, dispose, again.
    queue.attach()
    queue.showView('upload')
    queue.dispose()
    queue.attach()
    queue.showView('upload')
    await until(() => rows(queue).length === 1)
    expect(api.listJobs).toHaveBeenCalledTimes(2)
    queue.dispose()
  })
})

describe('UploadQueue: while a start runs (T-11)', () => {
  it('takes no files and moves nothing, but adds an empty group', async () => {
    const { api, events, script } = server()
    script('job-1', { status: 'analyzed' })
    script('job-2', { status: 'analyzed' })
    const queue = makeQueue(api, events)
    queue.addFiles([wav('a.wav'), wav('b.wav')])
    await until(() => rows(queue).every((file) => file.phase === 'ready'))
    // The dispatch never answers, so the start keeps running.
    api.dispatchJob.mockImplementation(() => new Promise(() => undefined))
    void queue.start()
    expect(queue.getSnapshot().processing).toBe(true)
    expect(queue.addFiles([wav('c.wav')])).toEqual([])
    queue.moveFile({ groupIndex: 0, fileIndex: 0 }, 0, 1)
    expect(rows(queue).map((file) => file.name)).toEqual(['a.wav', 'b.wav'])
    // kiChat's "+" stays open; the start does not touch the new group.
    queue.addGroup()
    expect(queue.getSnapshot().groups).toHaveLength(2)
    expect(queue.getSnapshot().groups[1]?.files).toEqual([])
    queue.dispose()
  })

  it('cancels a removed file, leaves its group unsaved and reuses the rest next time', async () => {
    const { api, events, script } = server()
    script('job-1', { status: 'analyzed', speakers: SPEAKERS })
    script('job-2', { status: 'analyzed', speakers: SPEAKERS })
    const queue = makeQueue(api, events)
    queue.addFiles([wav('a.wav'), wav('b.wav')])
    await until(() => rows(queue).every((file) => file.phase === 'ready'))
    script('job-1', { status: 'completed', result: result('A', 5) })
    script('job-2', { status: 'transcribing' })
    const started = queue.start()
    await until(() => row(queue, 'b.wav')?.phase === 'transcribing')

    expect(queue.removalDeletesJob(row(queue, 'b.wav').id)).toBe(true)
    expect(await queue.removeFile(row(queue, 'b.wav').id)).toBe(true)
    expect(api.deleteJob).toHaveBeenCalledWith('job-2')
    expect(await started).toEqual({ status: 'done', savedIds: [], failed: true })
    expect(api.createTranscript).not.toHaveBeenCalled()
    expect(rows(queue).map((file) => file.name)).toEqual(['a.wav'])
    expect(row(queue, 'a.wav').result?.text).toBe('A')

    // The next start reuses the result and saves the group with the file that stayed.
    const dispatches = api.dispatchJob.mock.calls.length
    expect(await queue.start()).toMatchObject({ savedIds: ['transcript-1'], failed: false })
    expect(api.dispatchJob).toHaveBeenCalledTimes(dispatches)
    expect(api.createTranscript.mock.calls[0]?.[0]).toMatchObject({ jobIds: ['job-1'] })
    queue.dispose()
  })

  it('does not fail a removed file whose job the stream reports gone first', async () => {
    const { api, events, script } = server()
    script('job-1', { status: 'analyzed', speakers: SPEAKERS })
    const queue = makeQueue(api, events)
    queue.addFiles([wav('a.wav')])
    await until(() => row(queue, 'a.wav')?.phase === 'ready')
    script('job-1', { status: 'transcribing' })
    const started = queue.start()
    // The transcription is followed.
    await until(() => events.subscribers === 1)
    const phases: string[] = []
    queue.subscribe(() => phases.push(rows(queue)[0]?.phase ?? 'gone'))
    // The server hides the job at once, so `jobRemoved` comes before the deletion's answer.
    api.deleteJob.mockImplementationOnce(async (id) => {
      events.emit({ type: 'jobRemoved', data: { id } })
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
    expect(await queue.removeFile(row(queue, 'a.wav').id)).toBe(true)
    expect(await started).toMatchObject({ savedIds: [], failed: true })
    expect(phases).not.toContain('failed')
    expect(rows(queue)).toEqual([])
    expect(events.subscribers).toBe(0)
    queue.dispose()
  })

  it('fails a file whose job was lost while its deletion failed, so the start ends', async () => {
    const { api, events, script } = server()
    script('job-1', { status: 'analyzed', speakers: SPEAKERS })
    const queue = makeQueue(api, events)
    queue.addFiles([wav('a.wav')])
    await until(() => row(queue, 'a.wav')?.phase === 'ready')
    script('job-1', { status: 'transcribing' })
    const started = queue.start()
    await until(() => events.subscribers === 1)
    api.deleteJob.mockImplementationOnce(async (id) => {
      events.emit({ type: 'jobRemoved', data: { id } })
      await new Promise((resolve) => setTimeout(resolve, 5))
      throw new ApiRequestError(500, null)
    })
    expect(await queue.removeFile(row(queue, 'a.wav').id)).toBe(false)
    expect(await started).toMatchObject({ savedIds: [], failed: true })
    expect(row(queue, 'a.wav')).toMatchObject({ phase: 'failed', tone: 'error' })
    expect(events.subscribers).toBe(0)
    queue.dispose()
  })

  it('fails a restored file whose fetches gave out while its deletion failed', async () => {
    const { api, events, script } = server()
    script('job-r', { status: 'transcribing' })
    api.listJobs.mockResolvedValue([job('job-r', { status: 'transcribing', speakers: SPEAKERS })])
    const queue = makeQueue(api, events)
    queue.attach()
    queue.showView('upload')
    await until(() => rows(queue).length === 1 && events.subscribers === 1)
    // The start waits for the restored transcription.
    const started = queue.start()
    let refuse: () => void = () => undefined
    api.deleteJob.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          refuse = () => reject(new ApiRequestError(500, null))
        })
    )
    const removed = queue.removeFile(rows(queue)[0]!.id)
    api.getJob.mockClear()
    api.getJob.mockRejectedValue(new Error('offline'))
    events.setOpen(true)
    await until(() => api.getJob.mock.calls.length === 5)
    await new Promise((resolve) => setTimeout(resolve, 5))
    // The flow waits for the deletion before it fails the row.
    expect(rows(queue)[0]).toMatchObject({ phase: 'transcribing' })
    refuse()
    expect(await removed).toBe(false)
    expect(await started).toMatchObject({ savedIds: [], failed: true })
    expect(rows(queue)[0]).toMatchObject({
      phase: 'failed',
      error: { key: 'transcriptionError', message: 'offline' }
    })
    expect(events.subscribers).toBe(0)
    queue.dispose()
  })

  it('cancels a whole group and goes on with the next one', async () => {
    const { api, events, script } = server()
    script('job-1', { status: 'analyzed', speakers: SPEAKERS })
    script('job-2', { status: 'analyzed', speakers: SPEAKERS })
    const queue = makeQueue(api, events)
    queue.addFiles([wav('a.wav')], 0)
    queue.addFiles([wav('b.wav')], 1)
    await until(() => rows(queue).every((file) => file.phase === 'ready'))
    script('job-1', { status: 'transcribing' })
    script('job-2', { status: 'completed', result: result('B', 4) })
    const started = queue.start()
    await until(() => row(queue, 'a.wav')?.phase === 'transcribing')

    expect(await queue.removeGroup(queue.getSnapshot().groups[0]!.id)).toBe(true)
    expect(await started).toEqual({ status: 'done', savedIds: ['transcript-1'], failed: true })
    expect(api.deleteJob).toHaveBeenCalledWith('job-1')
    expect(api.createTranscript).toHaveBeenCalledOnce()
    expect(api.createTranscript.mock.calls[0]?.[0]).toMatchObject({ jobIds: ['job-2'] })
    queue.dispose()
  })
})

describe('UploadQueue: back at the entry choice (T-01)', () => {
  it('clears an unfinished selection, so the next file starts a new transcript', async () => {
    const { api, events, script } = server()
    script('job-1', { status: 'failed', error: { code: 'analysis_failed', message: 'x' } })
    const queue = makeQueue(api, events)
    queue.addFiles([wav('old.wav')])
    await until(() => row(queue, 'old.wav').phase === 'analysisFailed')
    // The page mounted at the choice, went to the upload and back; a remount reports it again.
    queue.showView('choice')
    queue.showView('upload')
    expect(rows(queue)).toHaveLength(1)
    queue.showView('choice')
    expect(queue.getSnapshot().groups).toEqual([])
    // The job stays on the server for the next visit to restore.
    expect(api.deleteJob).not.toHaveBeenCalled()
    queue.addFiles([wav('new.wav')])
    expect(queue.getSnapshot().groups.map((group) => group.files.map((file) => file.name))).toEqual(
      [['new.wav']]
    )
    queue.dispose()
  })

  it('keeps everything while a start runs', async () => {
    const { api, events, script } = server()
    script('job-1', { status: 'analyzed' })
    const queue = makeQueue(api, events)
    queue.addFiles([wav('a.wav')])
    await until(() => row(queue, 'a.wav').phase === 'ready')
    api.dispatchJob.mockImplementation(() => new Promise(() => undefined))
    void queue.start()
    queue.resetSelection()
    expect(rows(queue).map((file) => file.name)).toEqual(['a.wav'])
    queue.dispose()
  })
})

describe('UploadQueue: files per transcript (T-04, T-13)', () => {
  it('adds and moves no more files into a group than a transcript takes', async () => {
    const { api, events } = server()
    const queue = makeQueue(api, events)
    queue.configure({ maxFilesPerGroup: 2 })
    expect(queue.addFiles([wav('a.wav'), wav('b.wav'), wav('c.wav')], 0)).toHaveLength(2)
    queue.addGroup()
    queue.addFiles([wav('d.wav')], 1)
    expect(queue.moveFile({ groupIndex: 1, fileIndex: 0 }, 0)).toBe(false)
    expect(queue.moveFile({ groupIndex: 0, fileIndex: 1 }, 0, 0)).toBe(true)
    expect(queue.getSnapshot().groups.map((group) => group.files.map((file) => file.name))).toEqual(
      [['b.wav', 'a.wav'], ['d.wav']]
    )
    queue.dispose()
  })

  it('takes a distinct file when the selection repeats one already there (T-05)', async () => {
    const { api, events } = server()
    const queue = makeQueue(api, events)
    queue.configure({ maxFilesPerGroup: 2 })
    queue.addFiles([wav('a.wav')], 0)
    expect(queue.addFiles([wav('a.wav'), wav('b.wav')], 0).map((file) => file.name)).toEqual([
      'b.wav'
    ])
    expect(rows(queue).map((file) => file.name)).toEqual(['a.wav', 'b.wav'])
    queue.dispose()
  })

  it('lets a file moved out free its place for a new upload (T-07)', async () => {
    const { api, events, script } = server()
    script('job-1', { status: 'analyzed', speakers: SPEAKERS })
    script('job-2', { status: 'analyzed', speakers: SPEAKERS })
    script('job-3', { status: 'analyzed', speakers: SPEAKERS })
    const queue = makeQueue(api, events)
    queue.configure({ maxFilesPerGroup: 2 })
    queue.addFiles([wav('a.wav'), wav('b.wav')], 0)
    await until(() => rows(queue).every((file) => file.phase === 'ready'))
    queue.addGroup()
    expect(queue.moveFile({ groupIndex: 0, fileIndex: 1 }, 1)).toBe(true)
    queue.addFiles([wav('c.wav')], 0)
    await until(() => row(queue, 'c.wav').phase === 'ready')
    expect(queue.getSnapshot().groups.map((group) => group.files.map((file) => file.name))).toEqual(
      [['a.wav', 'c.wav'], ['b.wav']]
    )
    queue.dispose()
  })

  it('adds recorded takes to the first group next to its file, within the limit (T-58)', () => {
    const { api, events } = server()
    const queue = makeQueue(api, events)
    queue.configure({ maxFilesPerGroup: 3 })
    queue.addFiles([wav('dialog-de.wav')], 0)
    const takes = [wav('dialog-de.wav'), wav('take-1.wav'), wav('take-2.wav'), wav('take-3.wav')]
    const groups = queue.getSnapshot().groups
    const index = handoverGroupIndex(groups, 'first')
    expect(index).toBe(0)
    expect(queue.addFiles(takes, index).map((file) => file.name)).toEqual([
      'take-1.wav',
      'take-2.wav'
    ])
    expect(queue.getSnapshot().groups.map((group) => group.files.map((file) => file.name))).toEqual(
      [['dialog-de.wav', 'take-1.wav', 'take-2.wav']]
    )
    queue.dispose()
  })

  it('takes groups far beyond kiChat’s usual sizes without an admin limit (T-04)', () => {
    const { api, events } = server()
    const queue = makeQueue(api, events)
    queue.configure({ maxFilesPerGroup: null })
    const files = Array.from({ length: 150 }, (_, index) => wav(`${index}.wav`))
    expect(queue.addFiles(files, 0)).toHaveLength(150)
    queue.dispose()
  })
})

describe('UploadQueue: removing during an upload (T-08)', () => {
  it('stops the upload before the job is deleted', async () => {
    const { api, events } = server()
    let uploadSignal: AbortSignal | undefined
    const upload: SignedUpload = (_target, _body, options) =>
      new Promise((_resolve, reject) => {
        uploadSignal = options.signal
        options.signal?.addEventListener('abort', () => reject(new UploadError('aborted', null)))
      })
    const queue = makeQueue(api, events, upload)
    let abortedAtDelete: boolean | undefined
    api.deleteJob.mockImplementation(async () => {
      abortedAtDelete = uploadSignal?.aborted
    })
    queue.addFiles([wav('a.wav')])
    await until(() => uploadSignal !== undefined)
    expect(await queue.removeFile(row(queue, 'a.wav').id)).toBe(true)
    expect(abortedAtDelete).toBe(true)
    expect(rows(queue)).toEqual([])
    queue.dispose()
  })

  it('stops the uploads of a group before deleting its jobs', async () => {
    const { api, events } = server()
    const signals: AbortSignal[] = []
    const upload: SignedUpload = (_target, _body, options) =>
      new Promise(() => {
        if (options.signal) signals.push(options.signal)
      })
    const queue = makeQueue(api, events, upload)
    const abortedAtDelete: boolean[] = []
    api.deleteJob.mockImplementation(async () => {
      abortedAtDelete.push(signals.every((signal) => signal.aborted))
    })
    queue.addFiles([wav('a.wav'), wav('b.wav')])
    await until(() => signals.length === 2)
    expect(await queue.removeGroup(queue.getSnapshot().groups[0]!.id)).toBe(true)
    expect(abortedAtDelete).toEqual([true, true])
    queue.dispose()
  })
})

describe('UploadQueue: removing while a group is saved (T-08, T-14)', () => {
  /** Two analysed files whose transcriptions completed, ready for a start to save them. */
  async function completedGroup(
    api: FakeApi,
    events: FakeEvents,
    script: FakeServer['script']
  ): Promise<UploadQueue> {
    script('job-1', { status: 'analyzed', speakers: SPEAKERS })
    script('job-2', { status: 'analyzed', speakers: SPEAKERS })
    const queue = makeQueue(api, events)
    queue.addFiles([wav('a.wav'), wav('b.wav')])
    await until(() => rows(queue).every((file) => file.phase === 'ready'))
    script('job-1', { status: 'completed', result: result('A', 5) })
    script('job-2', { status: 'completed', result: result('B', 4) })
    return queue
  }

  it('deletes no job while the save’s answer is pending, and the group ends saved', async () => {
    const { api, events, script } = server()
    const queue = await completedGroup(api, events, script)
    let answer: () => void = () => undefined
    api.createTranscript.mockImplementationOnce(
      (input) => new Promise((resolve) => (answer = () => resolve(transcript(input))))
    )
    const started = queue.start()
    await until(() => api.createTranscript.mock.calls.length === 1)
    const groupId = queue.getSnapshot().groups[0]!.id
    expect(queue.isSaving(groupId)).toBe(true)
    queue.addGroup()
    expect(queue.moveFile({ groupIndex: 0, fileIndex: 0 }, 1)).toBe(false)

    // Confirmed after the save began: the removal waits for it.
    const removedFile = queue.removeFile(row(queue, 'a.wav').id)
    const removedGroup = queue.removeGroup(groupId)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(api.deleteJob).not.toHaveBeenCalled()

    answer()
    expect(await started).toEqual({ status: 'done', savedIds: ['transcript-1'], failed: false })
    expect(await removedFile).toBe(true)
    expect(await removedGroup).toBe(true)
    expect(api.deleteJob).not.toHaveBeenCalled()
    expect(api.createTranscript).toHaveBeenCalledOnce()
    expect(queue.isSaving(groupId)).toBe(false)
    expect(queue.getSnapshot().groups[0]).toMatchObject({ saved: { id: 'transcript-1' } })
    expect(rows(queue).map((file) => file.name)).toEqual(['a.wav', 'b.wav'])
    queue.dispose()
  })

  it('deletes no job while a refused save adopts another page’s transcript', async () => {
    const { api, events, script } = server()
    const queue = await completedGroup(api, events, script)
    script('job-1', { status: 'completed', result: result('A', 5), transcriptId: 'other-1' })
    script('job-2', { status: 'completed', result: result('B', 4), transcriptId: 'other-1' })
    api.createTranscript.mockRejectedValue(new ApiRequestError(409, null))
    let adopt: () => void = () => undefined
    const other = transcript({ title: 'a.wav' } as TranscriptionTranscriptCreate, 'other-1')
    api.getTranscript.mockImplementation(
      () => new Promise((resolve) => (adopt = () => resolve(other)))
    )
    const started = queue.start()
    await until(() => api.getTranscript.mock.calls.length === 1)
    const removed = queue.removeFile(row(queue, 'b.wav').id)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(api.deleteJob).not.toHaveBeenCalled()

    adopt()
    expect(await started).toMatchObject({ savedIds: ['other-1'], failed: false })
    expect(await removed).toBe(true)
    expect(api.deleteJob).not.toHaveBeenCalled()
    expect(queue.getSnapshot().groups[0]).toMatchObject({ saved: { id: 'other-1' } })
    queue.dispose()
  })

  it('removes the file as confirmed once the save failed', async () => {
    const { api, events, script } = server()
    const queue = await completedGroup(api, events, script)
    let fail: () => void = () => undefined
    api.createTranscript.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (fail = () => reject(new Error('offline'))))
    )
    const started = queue.start()
    await until(() => api.createTranscript.mock.calls.length === 1)
    const removed = queue.removeFile(row(queue, 'a.wav').id)
    fail()
    expect(await started).toMatchObject({ savedIds: [], failed: true })
    expect(await removed).toBe(true)
    expect(api.deleteJob).toHaveBeenCalledWith('job-1')
    expect(rows(queue).map((file) => file.name)).toEqual(['b.wav'])
    queue.dispose()
  })
})

describe('UploadQueue: the mapping dialog’s voices (T-18, T-21)', () => {
  it('offers the dialog for a restored analysed job without voices', async () => {
    const { api, events } = server()
    api.listJobs.mockResolvedValue([
      job('job-a', { status: 'analyzed', speakers: [] }),
      job('job-b', { status: 'analyzing', speakers: [] })
    ])
    const queue = makeQueue(api, events)
    await queue.restoreActiveJobs()
    // kiChat opens an empty dialog for an analysed job, to add voices there.
    expect(row(queue, 'job-a.wav').voices).toEqual([])
    expect(row(queue, 'job-b.wav').voices).toBeNull()
    queue.dispose()
  })

  it('keeps edits made without Save, which do not count as saved', async () => {
    const { api, events, script } = server()
    script('job-1', { status: 'analyzed', speakers: SPEAKERS })
    const queue = makeQueue(api, events)
    queue.addFiles([wav('a.wav')])
    await until(() => row(queue, 'a.wav').phase === 'ready')
    const fileId = row(queue, 'a.wav').id
    queue.updateVoices(fileId, (voices) => voices.map((voice) => ({ ...voice, samples: [] })))
    expect(row(queue, 'a.wav')).toMatchObject({ voicesSaved: false })
    expect(row(queue, 'a.wav').voices?.[0]?.samples).toEqual([])
    queue.dispose()
  })

  it('tells the dialog when the repeated analysis answers that it runs', async () => {
    const { api, events, script } = server()
    script('job-1', { status: 'analyzed', speakers: SPEAKERS })
    const queue = makeQueue(api, events)
    queue.addFiles([wav('a.wav')])
    await until(() => row(queue, 'a.wav').phase === 'ready')
    script('job-1', { status: 'analyzing' }, { status: 'analyzed', speakers: SPEAKERS })
    const onPoll = vi.fn()
    const outcome = await queue.reanalyze(row(queue, 'a.wav').id, { keepVoices: false, onPoll })
    expect(outcome).toEqual({ ok: true })
    expect(onPoll).toHaveBeenCalledTimes(1)
    queue.dispose()
  })
})

describe('UploadQueue: restoring when the upload view opens (T-15)', () => {
  it('restores nothing at the page load, then each time the upload view opens', async () => {
    const { api, events } = server()
    api.listJobs.mockResolvedValue([job('job-a', { status: 'analyzed', speakers: SPEAKERS })])
    const queue = makeQueue(api, events)
    queue.attach()
    queue.showView('choice')
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(api.listJobs).not.toHaveBeenCalled()

    queue.showView('upload')
    await until(() => rows(queue).length === 1)
    // Back at the choice the selection goes; the upload view brings the job back.
    queue.showView('choice')
    expect(rows(queue)).toEqual([])
    queue.showView('upload')
    await until(() => rows(queue).length === 1)
    // A repeated report (a remount) lists again but adds nothing twice.
    queue.showView('upload')
    await until(() => api.listJobs.mock.calls.length === 3)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(rows(queue)).toHaveLength(1)
    queue.dispose()
  })

  it('does not list twice while a listing runs', async () => {
    const { api, events } = server()
    let answer: (jobs: TranscriptionJob[]) => void = () => undefined
    api.listJobs.mockImplementation(() => new Promise((resolve) => (answer = resolve)))
    const queue = makeQueue(api, events)
    queue.showView('upload')
    queue.showView('upload')
    expect(api.listJobs).toHaveBeenCalledOnce()
    answer([job('job-a', { status: 'analyzed' })])
    await until(() => rows(queue).length === 1)
    queue.dispose()
  })

  it('lets recorded takes join the first group after the restored jobs are back (T-58)', async () => {
    const { api, events } = server()
    let answer: (jobs: TranscriptionJob[]) => void = () => undefined
    api.listJobs.mockImplementation(() => new Promise((resolve) => (answer = resolve)))
    const queue = makeQueue(api, events)
    queue.attach()
    queue.showView('upload')
    let restored = false
    void queue.whenRestored().then(() => (restored = true))
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(restored).toBe(false)
    answer([job('job-a', { filename: 'dialog-de.wav', status: 'analyzed', speakers: SPEAKERS })])
    await queue.whenRestored()
    const index = handoverGroupIndex(queue.getSnapshot().groups, 'first')
    queue.addFiles([wav('take.wav')], index)
    const [first] = queue.getSnapshot().groups
    expect(first?.name).toBe('dialog-de')
    expect(first?.files.map((file) => file.name)).toEqual(['dialog-de.wav', 'take.wav'])
    queue.dispose()
  })

  it('waits for a job being created, so it is not restored next to its own row', async () => {
    const { api, events, script } = server()
    script('job-1', { status: 'analyzed', speakers: SPEAKERS })
    let created: () => void = () => undefined
    const create = api.createJob.getMockImplementation()!
    api.createJob.mockImplementationOnce(
      (input) => new Promise((resolve) => (created = () => resolve(create(input))))
    )
    // The server lists the job before the row hears its id.
    api.listJobs.mockResolvedValue([job('job-1', { status: 'uploading' })])
    const queue = makeQueue(api, events)
    queue.addFiles([wav('a.wav')])
    await until(() => row(queue, 'a.wav').phase === 'uploading')
    const restoring = queue.restoreActiveJobs()
    await new Promise((resolve) => setTimeout(resolve, 5))
    created()
    await restoring
    expect(rows(queue).map((file) => file.name)).toEqual(['a.wav'])
    queue.dispose()
  })

  it('restores nothing listed after the page went back to the choice', async () => {
    const { api, events, script } = server()
    script('job-a', { status: 'completed', result: result('A', 5) })
    let answer: (jobs: TranscriptionJob[]) => void = () => undefined
    api.listJobs.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
    const queue = makeQueue(api, events)
    queue.attach()
    queue.showView('choice')
    queue.showView('upload')
    const restored = queue.whenRestored()
    queue.showView('choice')
    answer([job('job-a', { status: 'transcribing', speakers: SPEAKERS })])
    await restored
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(rows(queue)).toEqual([])
    expect(api.getJob).not.toHaveBeenCalled()
    expect(api.createTranscript).not.toHaveBeenCalled()

    // The next visit lists again and resumes the job there.
    api.listJobs.mockResolvedValue([job('job-a', { status: 'transcribing', speakers: SPEAKERS })])
    queue.showView('upload')
    await until(() => Boolean(queue.getSnapshot().groups[0]?.saved))
    expect(api.listJobs).toHaveBeenCalledTimes(2)
    queue.dispose()
  })

  it('restores nothing after a dispose and re-attach while it waited for a job being created', async () => {
    const { api, events, script } = server()
    script('job-1', { status: 'analyzed', speakers: SPEAKERS })
    let created: () => void = () => undefined
    const create = api.createJob.getMockImplementation()!
    api.createJob.mockImplementationOnce(
      (input) => new Promise((resolve) => (created = () => resolve(create(input))))
    )
    api.listJobs.mockResolvedValueOnce([
      job('job-1', { status: 'uploading' }),
      job('job-x', { status: 'analyzed', speakers: SPEAKERS })
    ])
    const queue = makeQueue(api, events)
    queue.attach()
    queue.addFiles([wav('a.wav')])
    await until(() => row(queue, 'a.wav').phase === 'uploading')
    queue.showView('upload')
    const restored = queue.whenRestored()
    await new Promise((resolve) => setTimeout(resolve, 5))
    // As React's StrictMode remounts: the old restore must not take the new lifetime for its own.
    queue.dispose()
    queue.attach()
    await restored
    expect(rows(queue).map((file) => file.name)).toEqual(['a.wav'])

    // The remount reports the view again; that listing finds nothing new.
    queue.showView('upload')
    created()
    await queue.whenRestored()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(rows(queue).map((file) => file.name)).toEqual(['a.wav'])
    expect(api.listJobs).toHaveBeenCalledTimes(2)
    queue.dispose()
  })
})

describe('UploadQueue: a group saved by another page (T-14)', () => {
  /** Two analysed files whose jobs then end as `saved` says; the save answers `409`. */
  async function completedGroup(
    api: FakeApi,
    events: FakeEvents,
    script: FakeServer['script'],
    saved: [string | null, string | null],
    extra: Partial<UploadQueueOptions> = {}
  ): Promise<UploadQueue> {
    script('job-1', { status: 'analyzed', speakers: SPEAKERS })
    script('job-2', { status: 'analyzed', speakers: SPEAKERS })
    const queue = makeQueue(api, events, undefined, extra)
    queue.addFiles([wav('a.wav'), wav('b.wav')])
    await until(() => rows(queue).every((file) => file.phase === 'ready'))
    script('job-1', { status: 'completed', result: result('A', 5), transcriptId: saved[0] })
    script('job-2', { status: 'completed', result: result('B', 4), transcriptId: saved[1] })
    api.createTranscript.mockRejectedValue(new ApiRequestError(409, null))
    return queue
  }

  it('takes the transcript another page saved the jobs as', async () => {
    const { api, events, script } = server()
    const adopted = vi.fn()
    const queue = await completedGroup(api, events, script, ['other-1', 'other-1'], {
      onSaveAdopted: adopted
    })
    const other = transcript({ title: 'b.wav' } as TranscriptionTranscriptCreate, 'other-1')
    api.getTranscript.mockResolvedValue(other)

    expect(await queue.start()).toEqual({ status: 'done', savedIds: ['other-1'], failed: false })
    const group = queue.getSnapshot().groups[0]!
    expect(group).toMatchObject({
      saved: { id: 'other-1', title: 'b.wav' },
      saveFailed: false,
      saveConflict: null
    })
    expect(rows(queue).every((file) => file.status === 'transcriptionComplete')).toBe(true)
    expect(adopted).toHaveBeenCalledWith(
      expect.objectContaining({ jobIds: ['job-1', 'job-2'] }),
      other
    )
    queue.dispose()
  })

  it('offers no retry when the jobs are in different transcripts or not completed', async () => {
    const { api, events, script } = server()
    const queue = await completedGroup(api, events, script, ['other-1', null])
    expect(await queue.start()).toMatchObject({ savedIds: [], failed: true })
    expect(queue.getSnapshot().groups[0]).toMatchObject({
      saved: null,
      saveFailed: false,
      saveConflict: 'savedElsewhere'
    })

    script('job-1', { status: 'analyzed' })
    script('job-2', { status: 'completed' })
    await queue.saveGroup(queue.getSnapshot().groups[0]!.id)
    expect(queue.getSnapshot().groups[0]).toMatchObject({
      saveFailed: false,
      saveConflict: 'notCompleted'
    })
    queue.dispose()
  })

  it('keeps the retry for other failures', async () => {
    const { api, events, script } = server()
    const queue = await completedGroup(api, events, script, [null, null])
    api.createTranscript.mockRejectedValue(new Error('offline'))
    expect(await queue.start()).toMatchObject({ failed: true })
    expect(queue.getSnapshot().groups[0]).toMatchObject({ saveFailed: true, saveConflict: null })
    queue.dispose()
  })
})

describe('UploadQueue: the AI title after saving (T-23)', () => {
  async function savedQueue(
    onTranscriptCreated: UploadQueueOptions['onTranscriptCreated']
  ): Promise<{ queue: UploadQueue; api: FakeApi }> {
    const { api, events, script } = server()
    script('job-1', { status: 'analyzed', speakers: SPEAKERS })
    const queue = makeQueue(api, events, undefined, { onTranscriptCreated })
    queue.addFiles([wav('a.wav')], 0)
    await until(() => rows(queue).every((file) => file.phase === 'ready'))
    script('job-1', { status: 'completed', result: result('A', 5) })
    await queue.start()
    return { queue, api }
  }

  it('hears of a new transcript, and its AI title becomes the link’s and the name', async () => {
    const created = vi.fn()
    const { queue, api } = await savedQueue(created)
    expect(created).toHaveBeenCalledOnce()
    const group = queue.getSnapshot().groups[0]!
    queue.takeGeneratedTitle('transcript-1', 'Gießener Interview')
    expect(queue.getSnapshot().groups[0]).toMatchObject({
      name: 'Gießener Interview',
      saved: { id: 'transcript-1', title: 'Gießener Interview' }
    })
    // Leaving the name field renames nothing back.
    expect(await queue.commitGroupName(group.id)).toBe(true)
    expect(api.patchTranscript).not.toHaveBeenCalled()
    expect(created).toHaveBeenCalledOnce()
  })

  it('keeps a name the user is changing', async () => {
    const { queue } = await savedQueue(undefined)
    const group = queue.getSnapshot().groups[0]!
    queue.renameGroup(group.id, 'Mein Name')
    queue.takeGeneratedTitle('transcript-1', 'Gießener Interview')
    expect(queue.getSnapshot().groups[0]).toMatchObject({
      name: 'Mein Name',
      saved: { title: 'Gießener Interview' }
    })
  })
})
