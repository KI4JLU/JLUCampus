import { describe, expect, it, vi, type Mock } from 'vitest'
import type {
  TranscriptionJob,
  TranscriptionJobStatus,
  TranscriptionResult,
  TranscriptionTranscript,
  TranscriptionTranscriptCreate
} from '@justcampus/shared'
import { ApiRequestError } from '@/lib/api'
import { SignedUploadError } from '../api'
import { allFiles, findFile, serverWaveform, type QueueFile } from './queue'
import { UploadQueue, type SignedUpload, type UploadApi } from './store'

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
  /** Sets the statuses a job answers with, one per request, the last one staying. */
  script: (id: string, ...steps: Partial<TranscriptionJob>[]) => void
}

/** A stand-in server; a new script of a job replaces the rest of its old one. */
function server(): FakeServer {
  const statuses = new Map<string, TranscriptionJob[]>()
  let created = 0
  const script = (id: string, ...steps: Partial<TranscriptionJob>[]): void => {
    statuses.set(
      id,
      steps.map((step) => job(id, step))
    )
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
      const steps = statuses.get(id) ?? []
      const next = steps.length > 1 ? steps.shift() : steps[0]
      if (!next) throw new ApiRequestError(404, null)
      return next
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
  return { api, script }
}

function makeQueue(api: UploadApi, upload: SignedUpload = async () => undefined): UploadQueue {
  const queue = new UploadQueue({
    api,
    upload,
    settings: { language: 'de', speakerCount: 'multi', llmCorrection: false },
    labels: { autoLabel: (n) => `Voice ${n}`, sampleLabel: (n) => `Sample ${n}` },
    measureDuration: async () => 12,
    pollMs: 1,
    restoredPollMs: 1,
    creepMs: 10_000
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
    const { api, script } = server()
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
    const queue = makeQueue(api, upload)
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
    const { api, script } = server()
    script('job-1', {
      status: 'failed',
      error: { code: 'diarization_failed', message: 'Diarization-Server antwortete mit Status 415' }
    })
    const queue = makeQueue(api)
    queue.addFiles([wav('bad.wav')])
    await until(() => row(queue, 'bad.wav').phase === 'analysisFailed')
    expect(row(queue, 'bad.wav')).toMatchObject({
      tone: 'error',
      status: 'failed',
      progress: 100,
      error: { key: 'analysisError', message: 'Diarization-Server antwortete mit Status 415' }
    })
  })

  it('still shows the server waveform after the speaker analysis failed (T-12)', async () => {
    const { api, script } = server()
    script('job-1', {
      status: 'failed',
      error: { code: 'analysis_failed', message: 'Sprecheranalyse fehlgeschlagen (503)' }
    })
    const queue = makeQueue(api)
    queue.addFiles([wav('large.wav')])
    await until(() => row(queue, 'large.wav').phase === 'analysisFailed')
    const file = row(queue, 'large.wav')
    expect(file).toMatchObject({ uploaded: true, voices: null })
    // The peaks were stored after normalising, before the diariser failed.
    expect(serverWaveform(file)).toEqual({ jobId: 'job-1', revision: 'analysisFailed' })
  })

  it('tells storage errors and session errors apart', async () => {
    const { api } = server()
    const queue = makeQueue(
      api,
      vi.fn(async () => {
        throw new SignedUploadError('status', 403)
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

describe('UploadQueue: start, merge and save (T-13, T-14)', () => {
  it('saves each group once all its files succeeded, and retries only what failed', async () => {
    const { api, script } = server()
    for (const id of ['job-1', 'job-2', 'job-3']) {
      script(id, { status: 'analyzed', speakers: SPEAKERS })
    }
    const queue = makeQueue(api)
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
    expect(row(queue, 'a.wav').status).toBe('done')
  })

  it('keeps voices added by hand when a failed transcription is retried (T-20)', async () => {
    const { api, script } = server()
    script('job-1', { status: 'analyzed', speakers: SPEAKERS })
    const queue = makeQueue(api)
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
    const { api } = server()
    const queue = makeQueue(api)
    expect(await queue.start()).toMatchObject({ status: 'empty' })
  })
})

describe('UploadQueue: removing (T-08)', () => {
  it('removes a row only once its job is deleted', async () => {
    const { api, script } = server()
    script('job-1', { status: 'analyzed', speakers: [] })
    const queue = makeQueue(api)
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
    const { api, script } = server()
    script('job-1', { status: 'analyzed', speakers: [] })
    const queue = makeQueue(api)
    queue.addFiles([wav('a.wav')])
    await until(() => row(queue, 'a.wav')?.phase === 'ready')
    api.deleteJob.mockRejectedValueOnce(new ApiRequestError(404, null))
    expect(await queue.removeFile(row(queue, 'a.wav').id)).toBe(true)
    expect(rows(queue)).toEqual([])
  })

  it('keeps a group with the files whose jobs could not be deleted', async () => {
    const { api, script } = server()
    script('job-1', { status: 'analyzed' })
    script('job-2', { status: 'analyzed' })
    const queue = makeQueue(api)
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

describe('UploadQueue: restoring active jobs (T-15)', () => {
  it('restores each job as its own group and saves finished transcriptions', async () => {
    const { api, script } = server()
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
    const queue = makeQueue(api)
    queue.attach()
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
    expect(row(queue, 'job-c.wav')).toMatchObject({ phase: 'analysisFailed', tone: 'error' })

    // A second restore adds nothing already in the queue.
    await queue.restoreActiveJobs()
    expect(rows(queue)).toHaveLength(3)
    queue.dispose()
  })

  it('lists again when the page left before the listing answered', async () => {
    const { api } = server()
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
    const queue = makeQueue(api)
    // As React's StrictMode mounts: attach, dispose, attach.
    queue.attach()
    queue.dispose()
    queue.attach()
    await until(() => rows(queue).length === 1)
    expect(api.listJobs).toHaveBeenCalledTimes(2)
    queue.dispose()
  })
})

describe('UploadQueue: while a start runs (T-11)', () => {
  it('takes no files and moves nothing', async () => {
    const { api, script } = server()
    script('job-1', { status: 'analyzed' })
    script('job-2', { status: 'analyzed' })
    const queue = makeQueue(api)
    queue.addFiles([wav('a.wav'), wav('b.wav')])
    await until(() => rows(queue).every((file) => file.phase === 'ready'))
    // The dispatch never answers, so the start keeps running.
    api.dispatchJob.mockImplementation(() => new Promise(() => undefined))
    void queue.start()
    expect(queue.getSnapshot().processing).toBe(true)
    expect(queue.addFiles([wav('c.wav')])).toEqual([])
    queue.moveFile({ groupIndex: 0, fileIndex: 0 }, 0, 1)
    expect(rows(queue).map((file) => file.name)).toEqual(['a.wav', 'b.wav'])
    expect(await queue.removeFile(rows(queue)[0]!.id)).toBe(true)
    expect(rows(queue)).toHaveLength(2)
    expect(api.deleteJob).not.toHaveBeenCalled()
    queue.dispose()
  })
})

describe('UploadQueue: back at the entry choice (T-01)', () => {
  it('clears an unfinished selection, so the next file starts a new transcript', async () => {
    const { api, script } = server()
    script('job-1', { status: 'failed', error: { code: 'analysis_failed', message: 'x' } })
    const queue = makeQueue(api)
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
    const { api, script } = server()
    script('job-1', { status: 'analyzed' })
    const queue = makeQueue(api)
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
    const { api } = server()
    const queue = makeQueue(api)
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
    const { api } = server()
    const queue = makeQueue(api)
    queue.configure({ maxFilesPerGroup: 2 })
    queue.addFiles([wav('a.wav')], 0)
    expect(queue.addFiles([wav('a.wav'), wav('b.wav')], 0).map((file) => file.name)).toEqual([
      'b.wav'
    ])
    expect(rows(queue).map((file) => file.name)).toEqual(['a.wav', 'b.wav'])
    queue.dispose()
  })

  it('lets a file moved out free its place for a new upload (T-07)', async () => {
    const { api, script } = server()
    script('job-1', { status: 'analyzed', speakers: SPEAKERS })
    script('job-2', { status: 'analyzed', speakers: SPEAKERS })
    script('job-3', { status: 'analyzed', speakers: SPEAKERS })
    const queue = makeQueue(api)
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

  it('takes groups far beyond kiChat’s usual sizes without an admin limit (T-04)', () => {
    const { api } = server()
    const queue = makeQueue(api)
    queue.configure({ maxFilesPerGroup: null })
    const files = Array.from({ length: 150 }, (_, index) => wav(`${index}.wav`))
    expect(queue.addFiles(files, 0)).toHaveLength(150)
    queue.dispose()
  })
})

describe('UploadQueue: removing during an upload (T-08)', () => {
  it('stops the upload before the job is deleted', async () => {
    const { api } = server()
    let uploadSignal: AbortSignal | undefined
    const upload: SignedUpload = (_target, _body, options) =>
      new Promise((_resolve, reject) => {
        uploadSignal = options.signal
        options.signal?.addEventListener('abort', () =>
          reject(new SignedUploadError('aborted', null))
        )
      })
    const queue = makeQueue(api, upload)
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
    const { api } = server()
    const signals: AbortSignal[] = []
    const upload: SignedUpload = (_target, _body, options) =>
      new Promise(() => {
        if (options.signal) signals.push(options.signal)
      })
    const queue = makeQueue(api, upload)
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
