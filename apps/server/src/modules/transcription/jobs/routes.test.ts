import {
  TRANSCRIPTION_API,
  TRANSCRIPTION_DEFAULT_CONFIG,
  TRANSCRIPTION_MAX_FILE_BYTES,
  type TranscriptionComponentConfig
} from '@justcampus/shared'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../../../api.js'
import type { AppEnvironment } from '../../types.js'
import type { JobRow } from './rows.js'
import type { JobChanges, JobInsert } from './store.js'

/** The jobs table in memory, with the store's ownership and status rules. */
const state = vi.hoisted(() => ({
  rows: new Map<string, JobRow>(),
  wakes: 0,
  storage: {
    presignUpload: vi.fn(),
    presignDownload: vi.fn(),
    head: vi.fn(),
    deletePrefix: vi.fn()
  }
}))

vi.mock('./store.js', () => {
  const live = (row: JobRow, now = new Date()): boolean =>
    row.deletedAt === null &&
    (row.transcriptId !== null || row.expiresAt === null || row.expiresAt > now)
  return {
    findJob: async (id: string, componentId: string, userId: string) => {
      const row = state.rows.get(id)
      return row && row.componentId === componentId && row.userId === userId && live(row)
        ? row
        : undefined
    },
    findJobForDeletion: async (id: string, componentId: string, userId: string) => {
      const row = state.rows.get(id)
      return row && row.componentId === componentId && row.userId === userId ? row : undefined
    },
    listJobs: async (componentId: string, userId: string) =>
      [...state.rows.values()].filter(
        (row) =>
          row.componentId === componentId &&
          row.userId === userId &&
          row.transcriptId === null &&
          live(row)
      ),
    countActiveJobs: async (_componentId: string, userId: string) =>
      [...state.rows.values()].filter(
        (row) =>
          row.userId === userId &&
          live(row) &&
          !['analyzed', 'completed', 'failed'].includes(row.status)
      ).length,
    countGroupJobs: async (_componentId: string, userId: string, groupId: string) =>
      [...state.rows.values()].filter((row) => row.userId === userId && row.groupId === groupId)
        .length,
    insertJob: async (values: JobInsert) => {
      const now = new Date()
      const row = {
        groupId: null,
        groupOrder: 0,
        mimeType: '',
        duration: null,
        normalizedKey: null,
        speakers: [],
        mapping: {},
        snippets: [],
        colors: {},
        progress: null,
        result: null,
        error: null,
        upstreamJobId: null,
        transcriptId: null,
        attempts: 0,
        claimedAt: null,
        heartbeatAt: null,
        cancelRequestedAt: null,
        uploadedAt: null,
        completedAt: null,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
        expiresAt: null,
        ...values
      } as JobRow
      state.rows.set(row.id, row)
      return row
    },
    transitionJob: async (id: string, from: string[], changes: JobChanges) => {
      const row = state.rows.get(id)
      if (!row || !from.includes(row.status) || row.deletedAt) return undefined
      const next = { ...row, ...changes, updatedAt: new Date() } as JobRow
      state.rows.set(id, next)
      return next
    },
    markDeleted: async (id: string) => {
      const row = state.rows.get(id)!
      const next = {
        ...row,
        deletedAt: row.deletedAt ?? new Date(),
        cancelRequestedAt: new Date(),
        status: ['completed', 'failed'].includes(row.status) ? row.status : 'cancelled'
      }
      state.rows.set(id, next)
      return next
    },
    deleteJobRow: async (id: string) => {
      state.rows.delete(id)
    },
    claimHeld: (row: JobRow) => row.claimedAt !== null,
    unchangedSince: () => undefined
  }
})
vi.mock('../storage.js', async (original) => ({
  ...(await original<typeof import('../storage.js')>()),
  transcriptionStorage: () => state.storage
}))
vi.mock('./worker.js', () => ({
  CLAIM_LEASE_MS: 120_000,
  wakeJobWorker: () => {
    state.wakes++
  }
}))

const { jobsRouter } = await import('./index.js')

const componentId = '00000000-0000-4000-8000-000000000001'

const configured: TranscriptionComponentConfig = {
  ...TRANSCRIPTION_DEFAULT_CONFIG,
  asrBaseUrl: 'https://asr.test/v1',
  asrModels: [{ id: 'jlu/whisper-1', label: 'Whisper' }],
  llmBaseUrl: 'https://llm.test/v1',
  llmModels: [{ id: 'chat', label: 'Chat' }],
  maxActiveJobsPerUser: 3,
  maxFilesPerGroup: 2
}

function app(userId: string, config = configured): Hono<AppEnvironment> {
  const testApp = new Hono<AppEnvironment>()
  testApp.use('*', async (context, next) => {
    context.set('session', { user: { id: userId } } as AppEnvironment['Variables']['session'])
    context.set('module', {
      type: 'transcription',
      componentId,
      config,
      secrets: {
        apiKey: null,
        diarizationApiKey: null,
        llmApiKey: null,
        openaiRealtimeApiKey: null
      }
    })
    await next()
  })
  testApp.onError((error, context) => {
    if (error instanceof ApiError) {
      return context.json(
        { error: { code: error.code, message: error.message, issues: error.issues } },
        error.status
      )
    }
    throw error
  })
  testApp.route('/', jobsRouter)
  return testApp
}

/** A path of the contract relative to the module. */
const local = (path: string): string =>
  `http://test${path.replace('/api/modules/transcription', '')}`

function post(path: string, body?: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  }
}

const upload = { filename: 'campus-test.wav', size: 495_752, mimeType: 'audio/wav' }

async function createJob(
  userId = 'alice',
  input: Record<string, unknown> = upload
): Promise<{ response: Response; body: { job: { id: string }; upload: unknown } }> {
  const response = await app(userId).request(local(TRANSCRIPTION_API.jobs), post('', input))
  return { response, body: (await response.json()) as { job: { id: string }; upload: unknown } }
}

function setRow(id: string, changes: Partial<JobRow>): void {
  state.rows.set(id, { ...state.rows.get(id)!, ...changes })
}

const analyzedSpeakers = [
  {
    id: 'SPEAKER_00',
    index: 0,
    label: 'Stimme 1',
    start: 0.03,
    end: 10.7,
    samples: [{ id: 'SPEAKER_00-1', start: 0.03, end: 5.03 }]
  }
]

beforeEach(() => {
  state.rows.clear()
  state.wakes = 0
  state.storage.presignUpload.mockReset().mockImplementation(async (_key, options) => ({
    url: 'http://storage.test/upload?signature=x',
    method: 'PUT',
    headers: { 'Content-Type': options.contentType },
    expiresAt: '2026-10-04T09:00:00.000Z'
  }))
  state.storage.presignDownload.mockReset().mockImplementation(async (key: string) => ({
    url: `http://storage.test/${key}?signature=x`,
    expiresAt: '2026-10-04T10:00:00.000Z'
  }))
  state.storage.head.mockReset().mockResolvedValue({ size: 495_752, contentType: 'audio/wav' })
  state.storage.deletePrefix.mockReset().mockResolvedValue(3)
})

describe('upload session', () => {
  it('creates the job and a signed PUT for exactly its size and type', async () => {
    const { response, body } = await createJob()
    expect(response.status).toBe(201)
    expect(body).toMatchObject({
      job: {
        filename: 'campus-test.wav',
        size: 495_752,
        mimeType: 'audio/wav',
        status: 'uploading',
        settings: { language: 'auto', speakerCount: 'auto', llmCorrection: true },
        speakers: [],
        result: null
      },
      upload: { method: 'PUT', headers: { 'Content-Type': 'audio/wav' } }
    })
    expect(state.storage.presignUpload).toHaveBeenCalledWith(
      `transcription/${componentId}/jobs/${body.job.id}/source`,
      { contentType: 'audio/wav', contentLength: 495_752 }
    )
    expect(JSON.stringify(body.job)).not.toContain('transcription/')
  })

  it('validates name, type and size as kiChat (T-04)', async () => {
    const unsupported = await createJob('alice', {
      ...upload,
      filename: 'notes.txt',
      mimeType: 'text/plain'
    })
    expect(unsupported.response.status).toBe(400)
    // Accepted by type alone, by extension alone, and at the inclusive limit.
    expect(
      (await createJob('alice', { ...upload, filename: 'take', mimeType: 'audio/mp3' })).response
        .status
    ).toBe(201)
    expect(
      (await createJob('bob', { ...upload, filename: 'Video.MP4', mimeType: '' })).response.status
    ).toBe(201)
    expect(
      (await createJob('carol', { ...upload, size: TRANSCRIPTION_MAX_FILE_BYTES })).response.status
    ).toBe(201)
    const tooLarge = await createJob('dave', { ...upload, size: TRANSCRIPTION_MAX_FILE_BYTES + 1 })
    expect(tooLarge.response.status).toBe(400)
    expect(tooLarge.body).toMatchObject({
      error: { code: 'validation', issues: [{ path: ['size'] }] }
    })
  })

  it('signs a recording without type for its extension', async () => {
    const { body } = await createJob('alice', { filename: 'alice-20261004-101500.wav', size: 44 })
    expect(body.upload).toMatchObject({ headers: { 'Content-Type': 'audio/wav' } })
  })

  it('limits active jobs and files per group', async () => {
    for (let index = 0; index < 3; index++) {
      expect((await createJob('alice')).response.status).toBe(201)
    }
    const limited = await createJob('alice')
    expect(limited.response.status).toBe(429)
    const groupId = '22222222-2222-4222-8222-222222222222'
    expect((await createJob('bob', { ...upload, groupId })).response.status).toBe(201)
    expect((await createJob('bob', { ...upload, groupId, groupOrder: 1 })).response.status).toBe(
      201
    )
    expect((await createJob('bob', { ...upload, groupId, groupOrder: 2 })).response.status).toBe(
      400
    )
  })

  it('offers no uploads before transcription is set up', async () => {
    const response = await app('alice', TRANSCRIPTION_DEFAULT_CONFIG).request(
      local(TRANSCRIPTION_API.jobs),
      post('', upload)
    )
    expect(response.status).toBe(502)
  })
})

describe('ownership', () => {
  it('answers another user’s job like a missing one', async () => {
    const { body } = await createJob('alice')
    const id = body.job.id
    setRow(id, { status: 'analyzed', speakers: analyzedSpeakers })
    const bob = app('bob')
    for (const [method, path] of [
      ['GET', TRANSCRIPTION_API.job(id)],
      ['POST', TRANSCRIPTION_API.jobAnalyze(id)],
      ['GET', TRANSCRIPTION_API.jobAudio(id)],
      ['GET', TRANSCRIPTION_API.jobSample(id, 'SPEAKER_00-1')]
    ] as const) {
      const response = await bob.request(local(path), { method })
      expect(response.status, `${method} ${path}`).toBe(404)
    }
    const dispatch = await bob.request(
      local(TRANSCRIPTION_API.jobDispatch(id)),
      post('', { mapping: {}, snippets: [], speakerCount: 'auto', llmCorrection: false })
    )
    expect(dispatch.status).toBe(404)
    const list = await bob.request(local(TRANSCRIPTION_API.jobs))
    await expect(list.json()).resolves.toEqual({ jobs: [] })
    // Bob cannot delete it either: the job does not exist for him.
    const deleted = await bob.request(local(TRANSCRIPTION_API.job(id)), { method: 'DELETE' })
    expect(deleted.status).toBe(404)
    expect(state.rows.has(id)).toBe(true)
    expect(state.storage.deletePrefix).not.toHaveBeenCalled()
    expect((await app('bob').request(local(TRANSCRIPTION_API.job('not-a-uuid')))).status).toBe(404)
  })
})

describe('analysis', () => {
  it('checks the stored bytes and queues the analysis once', async () => {
    const { body } = await createJob()
    const id = body.job.id
    const response = await app('alice').request(
      local(TRANSCRIPTION_API.jobAnalyze(id)),
      post('', { duration: 11.240544 })
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'analyzingQueued',
      duration: 11.240544,
      progress: { phase: 'queued', currentChunk: 0, totalChunks: 0 }
    })
    expect(state.wakes).toBe(1)
    // A reconnecting browser asks again: nothing new starts.
    const again = await app('alice').request(local(TRANSCRIPTION_API.jobAnalyze(id)), post(''))
    expect(again.status).toBe(200)
    await expect(again.json()).resolves.toMatchObject({ status: 'analyzingQueued' })
    expect(state.wakes).toBe(1)
  })

  it('waits for an upload that has not arrived and fails one of the wrong size', async () => {
    const { body } = await createJob()
    state.storage.head.mockResolvedValueOnce(null)
    const missing = await app('alice').request(
      local(TRANSCRIPTION_API.jobAnalyze(body.job.id)),
      post('')
    )
    expect(missing.status).toBe(409)
    expect(state.rows.get(body.job.id)!.status).toBe('uploading')

    state.storage.head.mockResolvedValueOnce({ size: 17, contentType: 'audio/wav' })
    const wrong = await app('alice').request(
      local(TRANSCRIPTION_API.jobAnalyze(body.job.id)),
      post('')
    )
    expect(wrong.status).toBe(200)
    await expect(wrong.json()).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'upload_size_mismatch' }
    })
  })

  it('repeats an analysis (T-21) but not during the transcription', async () => {
    const { body } = await createJob()
    setRow(body.job.id, {
      status: 'analyzed',
      speakers: analyzedSpeakers,
      duration: 11.24,
      normalizedKey: 'n'
    })
    const repeat = await app('alice').request(
      local(TRANSCRIPTION_API.jobAnalyze(body.job.id)),
      post('')
    )
    await expect(repeat.json()).resolves.toMatchObject({
      status: 'analyzingQueued',
      duration: 11.24
    })
    setRow(body.job.id, { status: 'transcribing' })
    const busy = await app('alice').request(
      local(TRANSCRIPTION_API.jobAnalyze(body.job.id)),
      post('')
    )
    expect(busy.status).toBe(409)
  })

  it('takes the speaker count chosen since the upload (T-09)', async () => {
    const { body } = await createJob()
    expect(state.rows.get(body.job.id)!.settings.speakerCount).toBe('auto')
    const response = await app('alice').request(
      local(TRANSCRIPTION_API.jobAnalyze(body.job.id)),
      post('', { duration: 11.24, speakerCount: 'multi' })
    )
    expect(response.status).toBe(200)
    expect(state.rows.get(body.job.id)!.settings).toMatchObject({ speakerCount: 'multi' })
  })

  it('refuses a malformed body', async () => {
    const { body } = await createJob()
    const response = await app('alice').request(local(TRANSCRIPTION_API.jobAnalyze(body.job.id)), {
      method: 'POST',
      body: '{'
    })
    expect(response.status).toBe(400)
  })
})

describe('dispatch', () => {
  const input = {
    mapping: { SPEAKER_00: 'Test speaker' },
    snippets: [{ id: 'SPEAKER_00', name: 'Test speaker', start: 0.03096875, end: 5.03096875 }],
    speakerCount: 'auto',
    llmCorrection: true
  }

  async function analyzedJob(): Promise<string> {
    const { body } = await createJob()
    setRow(body.job.id, { status: 'analyzed', speakers: analyzedSpeakers, duration: 11.240544 })
    return body.job.id
  }

  it('starts the transcription with names, windows and settings, once', async () => {
    const id = await analyzedJob()
    const response = await app('alice').request(
      local(TRANSCRIPTION_API.jobDispatch(id)),
      post('', { ...input, language: 'de', colors: { SPEAKER_00: 4 } })
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'preprocessing',
      mapping: { SPEAKER_00: 'Test speaker' },
      snippets: input.snippets,
      colors: { SPEAKER_00: 4 },
      settings: { language: 'de', speakerCount: 'auto', llmCorrection: true }
    })
    expect(state.wakes).toBe(1)
    const again = await app('alice').request(
      local(TRANSCRIPTION_API.jobDispatch(id)),
      post('', input)
    )
    expect(again.status).toBe(409)
    expect(state.wakes).toBe(1)
  })

  it('takes the correction flag off (T-09)', async () => {
    const id = await analyzedJob()
    const response = await app('alice').request(
      local(TRANSCRIPTION_API.jobDispatch(id)),
      post('', { ...input, llmCorrection: false })
    )
    await expect(response.json()).resolves.toMatchObject({ settings: { llmCorrection: false } })
  })

  it('refuses a job not analysed yet and invalid windows', async () => {
    const { body } = await createJob()
    const early = await app('alice').request(
      local(TRANSCRIPTION_API.jobDispatch(body.job.id)),
      post('', input)
    )
    expect(early.status).toBe(409)
    const id = await analyzedJob()
    const outside = await app('alice').request(
      local(TRANSCRIPTION_API.jobDispatch(id)),
      post('', { ...input, snippets: [{ id: 'SPEAKER_00', name: 'A', start: 20, end: 25 }] })
    )
    expect(outside.status).toBe(400)
    const reversed = await app('alice').request(
      local(TRANSCRIPTION_API.jobDispatch(id)),
      post('', { ...input, snippets: [{ id: 'SPEAKER_00', name: 'A', start: 3, end: 2 }] })
    )
    expect(reversed.status).toBe(400)
    expect(state.rows.get(id)!.status).toBe('analyzed')
  })

  it('refuses the correction when no chat model is set up', async () => {
    const id = await analyzedJob()
    const response = await app('alice', { ...configured, llmBaseUrl: null }).request(
      local(TRANSCRIPTION_API.jobDispatch(id)),
      post('', input)
    )
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({
      error: { issues: [{ path: ['llmCorrection'] }] }
    })
  })

  it('dispatches again after a failed transcription, not after a failed analysis', async () => {
    const id = await analyzedJob()
    setRow(id, { status: 'failed', error: { code: 'asr_failed', message: 'Status 503' } })
    const retry = await app('alice').request(
      local(TRANSCRIPTION_API.jobDispatch(id)),
      post('', input)
    )
    expect(retry.status).toBe(200)
    setRow(id, { status: 'failed', error: { code: 'analysis_failed', message: 'Status 415' } })
    const refused = await app('alice').request(
      local(TRANSCRIPTION_API.jobDispatch(id)),
      post('', input)
    )
    expect(refused.status).toBe(409)
  })
})

describe('status, list and media', () => {
  it('shows the result in the status, but not in the list', async () => {
    const { body } = await createJob()
    const result = {
      text: 'Guten Tag.',
      language: 'de',
      duration: 11.24,
      segments: [
        { id: 1, start: 0, end: 10.72, text: 'Guten Tag.', speaker: 'Test speaker', redactions: [] }
      ],
      words: [],
      model: 'jlu/whisper-1',
      provider: null
    }
    setRow(body.job.id, { status: 'completed', result })
    const status = await app('alice').request(local(TRANSCRIPTION_API.job(body.job.id)))
    await expect(status.json()).resolves.toMatchObject({ status: 'completed', result })
    const list = await app('alice').request(local(TRANSCRIPTION_API.jobs))
    await expect(list.json()).resolves.toMatchObject({ jobs: [{ id: body.job.id, result: null }] })
  })

  it('leaves saved and expired jobs out of the active list', async () => {
    const saved = (await createJob()).body.job.id
    const expired = (await createJob()).body.job.id
    setRow(saved, {
      status: 'completed',
      transcriptId: '33333333-3333-4333-8333-333333333333',
      expiresAt: null
    })
    setRow(expired, { status: 'failed', expiresAt: new Date(Date.now() - 1000) })
    const list = await app('alice').request(local(TRANSCRIPTION_API.jobs))
    await expect(list.json()).resolves.toEqual({ jobs: [] })
    // A saved job's audio still plays in the history (T-24).
    const audio = await app('alice').request(local(TRANSCRIPTION_API.jobAudio(saved)))
    expect(audio.status).toBe(200)
    expect((await app('alice').request(local(TRANSCRIPTION_API.job(expired)))).status).toBe(404)
  })

  it('signs fresh audio and sample URLs', async () => {
    const { body } = await createJob()
    const id = body.job.id
    const early = await app('alice').request(local(TRANSCRIPTION_API.jobAudio(id)))
    expect(early.status).toBe(404)
    setRow(id, { status: 'analyzed', speakers: analyzedSpeakers })
    const audio = await app('alice').request(local(TRANSCRIPTION_API.jobAudio(id)))
    await expect(audio.json()).resolves.toEqual({
      url: `http://storage.test/transcription/${componentId}/jobs/${id}/source?signature=x`,
      expiresAt: '2026-10-04T10:00:00.000Z'
    })
    expect(state.storage.presignDownload).toHaveBeenLastCalledWith(
      `transcription/${componentId}/jobs/${id}/source`,
      { contentType: 'audio/wav', filename: 'campus-test.wav' }
    )
    const sample = await app('alice').request(
      local(TRANSCRIPTION_API.jobSample(id, 'SPEAKER_00-1'))
    )
    expect(sample.status).toBe(200)
    expect(state.storage.presignDownload).toHaveBeenLastCalledWith(
      `transcription/${componentId}/jobs/${id}/samples/SPEAKER_00-1.wav`,
      expect.objectContaining({ contentType: 'audio/wav' })
    )
    const unknown = await app('alice').request(
      local(TRANSCRIPTION_API.jobSample(id, 'SPEAKER_09-1'))
    )
    expect(unknown.status).toBe(404)
  })
})

describe('deletion', () => {
  it('cancels, deletes the audio and answers 404 once it is gone', async () => {
    const { body } = await createJob()
    const id = body.job.id
    const first = await app('alice').request(local(TRANSCRIPTION_API.job(id)), { method: 'DELETE' })
    expect(first.status).toBe(204)
    expect(state.storage.deletePrefix).toHaveBeenCalledWith(
      `transcription/${componentId}/jobs/${id}/`
    )
    expect(state.rows.has(id)).toBe(false)
    const second = await app('alice').request(local(TRANSCRIPTION_API.job(id)), {
      method: 'DELETE'
    })
    expect(second.status).toBe(404)
    expect((await app('alice').request(local(TRANSCRIPTION_API.job(id)))).status).toBe(404)
    const malformed = await app('alice').request(local(TRANSCRIPTION_API.job('not-a-uuid')), {
      method: 'DELETE'
    })
    expect(malformed.status).toBe(404)
  })

  it('leaves a running job’s row to the sweep, hidden at once', async () => {
    const { body } = await createJob()
    const id = body.job.id
    setRow(id, { status: 'transcribing', claimedAt: new Date(), heartbeatAt: new Date() })
    const response = await app('alice').request(local(TRANSCRIPTION_API.job(id)), {
      method: 'DELETE'
    })
    expect(response.status).toBe(204)
    expect(state.rows.get(id)).toMatchObject({ status: 'cancelled' })
    expect(state.rows.get(id)!.cancelRequestedAt).not.toBeNull()
    expect((await app('alice').request(local(TRANSCRIPTION_API.job(id)))).status).toBe(404)
  })

  it('reports a storage failure and finishes on the next try', async () => {
    const { body } = await createJob()
    const id = body.job.id
    state.storage.deletePrefix.mockRejectedValueOnce(new Error('storage down'))
    const failed = await app('alice').request(local(TRANSCRIPTION_API.job(id)), {
      method: 'DELETE'
    })
    expect(failed.status).toBe(502)
    expect((await app('alice').request(local(TRANSCRIPTION_API.job(id)))).status).toBe(404)
    const retried = await app('alice').request(local(TRANSCRIPTION_API.job(id)), {
      method: 'DELETE'
    })
    expect(retried.status).toBe(204)
    expect(state.rows.has(id)).toBe(false)
  })
})
