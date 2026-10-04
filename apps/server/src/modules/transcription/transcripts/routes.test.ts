import { TRANSCRIPTION_API } from '@justcampus/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GroupJob, NewTranscript, TranscriptChanges, TranscriptRow } from './store.js'
import { transcriptsRouter } from './index.js'
import { json, mockChatConfig, startUpstreamMock, testApp, type RunningMock } from './testing.js'

/** The store as rows in memory, with the same ownership and revision rules as the SQL. */
const fake = vi.hoisted(() => ({
  rows: [] as TranscriptRow[],
  jobs: [] as Array<GroupJob & { userId: string }>,
  clock: 0
}))

vi.mock('./store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./store.js')>()
  const tick = (): Date => new Date(Date.UTC(2026, 9, 4, 10, 0, fake.clock++))
  const owned = (componentId: string, userId: string | null) => (row: TranscriptRow) =>
    row.componentId === componentId && (userId === null || row.userId === userId)
  return {
    ...actual,
    listTranscripts: async (componentId: string, userId: string) =>
      fake.rows
        .filter(owned(componentId, userId))
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()),
    findTranscript: async (componentId: string, userId: string, id: string) =>
      fake.rows.find((row) => owned(componentId, userId)(row) && row.id === id) ?? null,
    saveTranscript: async (
      componentId: string,
      userId: string,
      idempotencyKey: string,
      jobIds: string[],
      build: (jobs: GroupJob[]) => NewTranscript
    ) => {
      const existing = fake.rows.find(
        (row) => row.userId === userId && row.idempotencyKey === idempotencyKey
      )
      if (existing) return { row: existing, created: false }
      const values = build(
        fake.jobs.filter((job) => job.userId === userId && jobIds.includes(job.id))
      )
      const now = tick()
      const row: TranscriptRow = {
        id: crypto.randomUUID(),
        componentId,
        userId,
        idempotencyKey,
        subtitle: null,
        subtitleSource: null,
        summaryTemplateId: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        ...values
      }
      fake.rows.push(row)
      for (const job of fake.jobs) if (jobIds.includes(job.id)) job.transcriptId = row.id
      return { row, created: true }
    },
    updateTranscript: async (
      componentId: string,
      userId: string,
      id: string,
      baseRevision: number | null,
      changes: TranscriptChanges,
      options: { bump: boolean }
    ) => {
      const row = fake.rows.find(
        (candidate) => owned(componentId, userId)(candidate) && candidate.id === id
      )
      if (!row || (baseRevision !== null && row.revision !== baseRevision)) return null
      Object.assign(row, changes)
      if (options.bump) {
        row.revision += 1
        row.updatedAt = tick()
      }
      return row
    },
    deleteTranscripts: async (componentId: string, userId: string | null, ids: string[]) => {
      const before = fake.rows.length
      fake.rows = fake.rows.filter(
        (row) => !(owned(componentId, userId)(row) && ids.includes(row.id))
      )
      return before - fake.rows.length
    },
    applyGeneratedMetadata: async (
      id: string,
      generated: { subtitle: string | null; title: string | null; titleWas: string }
    ) => {
      const row = fake.rows.find((candidate) => candidate.id === id)
      if (!row) return
      if (generated.subtitle && row.subtitle === null) {
        row.subtitle = generated.subtitle
        row.subtitleSource = 'ai'
      }
      if (generated.title && row.title === generated.titleWas) row.title = generated.title
    },
    setGeneratedSubtitle: async (
      componentId: string,
      userId: string,
      id: string,
      subtitle: string
    ) => {
      const row = fake.rows.find(
        (candidate) => owned(componentId, userId)(candidate) && candidate.id === id
      )
      if (!row) return null
      row.subtitle = subtitle
      row.subtitleSource = 'ai'
      return row
    }
  }
})

const jobA = '11111111-1111-4111-8111-111111111111'
const jobB = '22222222-2222-4222-8222-222222222222'
const jobOfBob = '55555555-5555-4555-8555-555555555555'
const relative = (path: string): string => path.replace('/api/modules/transcription', '')

function createBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    idempotencyKey: '33333333-3333-4333-8333-333333333333',
    title: 'interview',
    jobIds: [jobA, jobB],
    language: 'de',
    duration: 21,
    segments: [
      { id: 0, start: 0, end: 10, text: 'Guten Tag, wir planen das Treffen.', speaker: 'Anna' },
      { id: 1, start: 11, end: 21, text: 'Am Montag um 10 Uhr.', speaker: 'Ben' }
    ],
    sourceFiles: [
      { jobId: jobA, name: 'interview.wav', size: 10, duration: 10.5, startTime: 0, endTime: 10.5 },
      { jobId: jobB, name: 'b.wav', size: 20, duration: 10.5, startTime: 10.5, endTime: 21 }
    ],
    speakerColors: { Anna: { colorId: 2, speakerIndex: 0 } },
    ...overrides
  }
}

function resetJobs(): void {
  fake.rows = []
  fake.jobs = [
    {
      id: jobA,
      userId: 'alice',
      filename: 'interview.wav',
      size: 10,
      status: 'completed',
      transcriptId: null,
      result: null
    },
    {
      id: jobB,
      userId: 'alice',
      filename: 'b.wav',
      size: 20,
      status: 'completed',
      transcriptId: null,
      result: null
    },
    {
      id: jobOfBob,
      userId: 'bob',
      filename: 'c.wav',
      size: 5,
      status: 'completed',
      transcriptId: null,
      result: null
    }
  ]
}

beforeEach(resetJobs)

async function create(
  app = testApp(transcriptsRouter),
  body = createBody()
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await app.request(relative(TRANSCRIPTION_API.transcripts), json('POST', body))
  return { response, body: (await response.json()) as Record<string, unknown> }
}

describe('saving a group', () => {
  it('saves once per idempotency key and links the jobs', async () => {
    const first = await create()
    expect(first.response.status).toBe(201)
    expect(first.body).toMatchObject({
      title: 'interview',
      revision: 1,
      text: 'Guten Tag, wir planen das Treffen. Am Montag um 10 Uhr.',
      originalFilename: 'interview.wav',
      fileSize: 30,
      subtitle: null,
      expiresAt: null,
      speakerColors: { Anna: { colorId: 2, speakerIndex: 0 } }
    })
    expect(fake.jobs.filter((job) => job.transcriptId === first.body.id)).toHaveLength(2)

    const again = await create()
    expect(again.response.status).toBe(200)
    expect(again.body.id).toBe(first.body.id)
    expect(fake.rows).toHaveLength(1)
  })

  it('refuses another user’s job as not found and a saved job as a conflict', async () => {
    const foreign = await create(
      testApp(transcriptsRouter),
      createBody({ jobIds: [jobA, jobOfBob] })
    )
    expect(foreign.response.status).toBe(404)
    await create()
    const twice = await create(
      testApp(transcriptsRouter),
      createBody({ idempotencyKey: '66666666-6666-4666-8666-666666666666' })
    )
    expect(twice.response.status).toBe(409)
  })

  it('reports an expiry under the admin’s retention', async () => {
    const { body } = await create(
      testApp(transcriptsRouter, { config: { transcriptRetentionHours: 24 } })
    )
    const updated = new Date(String(body.updatedAt)).getTime()
    expect(new Date(String(body.expiresAt)).getTime() - updated).toBe(24 * 3_600_000)
  })

  it('validates the body', async () => {
    const response = await testApp(transcriptsRouter).request(
      relative(TRANSCRIPTION_API.transcripts),
      json('POST', createBody({ title: '' }))
    )
    expect(response.status).toBe(400)
  })
})

describe('history and detail', () => {
  it('lists the user’s transcripts newest change first, metadata only', async () => {
    const app = testApp(transcriptsRouter)
    const older = await create(app)
    fake.jobs.push({
      id: jobOfBob.replace('5555', '7777'),
      userId: 'alice',
      filename: 'x.wav',
      size: 1,
      status: 'completed',
      transcriptId: null,
      result: null
    })
    const newer = await create(
      app,
      createBody({
        idempotencyKey: '77777777-7777-4777-8777-777777777777',
        title: 'zweites',
        jobIds: [jobOfBob.replace('5555', '7777')],
        sourceFiles: []
      })
    )
    const response = await app.request(relative(TRANSCRIPTION_API.transcripts))
    const { transcripts } = (await response.json()) as {
      transcripts: Array<Record<string, unknown>>
    }
    expect(transcripts.map((entry) => entry.id)).toEqual([newer.body.id, older.body.id])
    expect(transcripts[0]).not.toHaveProperty('segments')
    expect(Object.keys(transcripts[0]!).sort()).toEqual(
      [
        'createdAt',
        'duration',
        'expiresAt',
        'id',
        'language',
        'originalFilename',
        'subtitle',
        'title',
        'updatedAt'
      ].sort()
    )

    const bob = await testApp(transcriptsRouter, { userId: 'bob' }).request(
      relative(TRANSCRIPTION_API.transcripts)
    )
    expect(await bob.json()).toEqual({ transcripts: [] })
  })

  it('answers 404 for another user’s transcript and for ids that are no UUID', async () => {
    const { body } = await create()
    const id = String(body.id)
    expect(
      (await testApp(transcriptsRouter).request(relative(TRANSCRIPTION_API.transcript(id)))).status
    ).toBe(200)
    const bob = testApp(transcriptsRouter, { userId: 'bob' })
    expect((await bob.request(relative(TRANSCRIPTION_API.transcript(id)))).status).toBe(404)
    expect(
      (
        await bob.request(
          relative(TRANSCRIPTION_API.transcript(id)),
          json('PATCH', { baseRevision: 1, title: 'x' })
        )
      ).status
    ).toBe(404)
    expect(
      (await bob.request(relative(TRANSCRIPTION_API.transcript(id)), { method: 'DELETE' })).status
    ).toBe(404)
    expect((await bob.request(relative(TRANSCRIPTION_API.transcript('nope')))).status).toBe(404)
    expect(fake.rows).toHaveLength(1)
  })
})

describe('changes', () => {
  it('changes title, segments and colours from the current revision only', async () => {
    const app = testApp(transcriptsRouter)
    const { body } = await create(app)
    const path = relative(TRANSCRIPTION_API.transcript(String(body.id)))

    const renamed = await app.request(path, json('PATCH', { baseRevision: 1, title: 'Planung' }))
    expect(renamed.status).toBe(200)
    expect(await renamed.json()).toMatchObject({ title: 'Planung', revision: 2 })

    const stale = await app.request(path, json('PATCH', { baseRevision: 1, title: 'Alt' }))
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ error: { code: 'conflict' } })

    const segments = [
      {
        id: 0,
        start: 0,
        end: 10,
        text: 'Guten Tag.',
        speaker: 'Anna',
        redactions: [{ start: 0, end: 5 }],
        avgLogprob: -0.1,
        tokens: [1, 2]
      },
      { id: 1, start: 11, end: 21, text: 'Bis Montag.', speaker: 'Anna' }
    ]
    const edited = await app.request(
      path,
      json('PATCH', {
        baseRevision: 2,
        segments,
        speakerColors: { Anna: { colorId: 5, speakerIndex: 0 } }
      })
    )
    expect(await edited.json()).toMatchObject({
      revision: 3,
      text: 'Guten Tag. Bis Montag.',
      segments: [
        { redactions: [{ start: 0, end: 5 }], avgLogprob: -0.1, tokens: [1, 2] },
        { redactions: [] }
      ],
      speakerColors: { Anna: { colorId: 5, speakerIndex: 0 } }
    })

    const detail = await (await app.request(path)).json()
    expect(detail).toMatchObject({ title: 'Planung', revision: 3, text: 'Guten Tag. Bis Montag.' })
  })

  it('keeps a typed subtitle as manual and removes it when empty', async () => {
    const app = testApp(transcriptsRouter)
    const { body } = await create(app)
    const path = relative(TRANSCRIPTION_API.transcript(String(body.id)))
    const typed = await app.request(path, json('PATCH', { baseRevision: 1, subtitle: ' Notiz ' }))
    expect(await typed.json()).toMatchObject({
      subtitle: 'Notiz',
      subtitleSource: 'manual',
      revision: 2
    })
    const removed = await app.request(path, json('PATCH', { baseRevision: 2, subtitle: '' }))
    expect(await removed.json()).toMatchObject({ subtitle: null, subtitleSource: null })
  })

  it('remembers the summary template without a new revision, from any revision', async () => {
    const app = testApp(transcriptsRouter)
    const { body } = await create(app)
    const path = relative(TRANSCRIPTION_API.transcript(String(body.id)))
    const response = await app.request(
      path,
      json('PATCH', { baseRevision: 7, summaryTemplateId: 'interview' })
    )
    expect(await response.json()).toMatchObject({ summaryTemplateId: 'interview', revision: 1 })
  })

  it('refuses an empty change', async () => {
    const { body } = await create()
    const response = await testApp(transcriptsRouter).request(
      relative(TRANSCRIPTION_API.transcript(String(body.id))),
      json('PATCH', { baseRevision: 1 })
    )
    expect(response.status).toBe(400)
  })
})

describe('deletion', () => {
  it('deletes once and answers 404 afterwards', async () => {
    const app = testApp(transcriptsRouter)
    const { body } = await create(app)
    const path = relative(TRANSCRIPTION_API.transcript(String(body.id)))
    expect((await app.request(path, { method: 'DELETE' })).status).toBe(204)
    expect((await app.request(path)).status).toBe(404)
    const again = await app.request(path, { method: 'DELETE' })
    expect(again.status).toBe(404)
    expect(await again.json()).toMatchObject({ error: { code: 'not_found' } })
  })
})

describe('AI subtitle and title', () => {
  let mock: RunningMock
  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    mock = await startUpstreamMock()
  })
  afterAll(async () => {
    await mock.close()
    vi.restoreAllMocks()
  })

  it('writes subtitle and made-up title after saving, in the background', async () => {
    const app = testApp(transcriptsRouter, { config: mockChatConfig(mock.origin) })
    const { response, body } = await create(app)
    expect(response.status).toBe(201)
    expect(body.subtitle).toBeNull()
    await vi.waitFor(() => {
      const row = fake.rows.find((candidate) => candidate.id === body.id)
      expect(row?.subtitle).toBe('Gespräch mit Anna, Ben über „Guten Tag, wir planen das Treffen“')
      expect(row?.title).toBe('Gespräch: Guten Tag, wir planen')
    })
    const detail = (await (
      await app.request(relative(TRANSCRIPTION_API.transcript(String(body.id))))
    ).json()) as Record<string, unknown>
    expect(detail).toMatchObject({ subtitleSource: 'ai', revision: 1 })
  })

  it('leaves a title the user chose and a subtitle typed meanwhile', async () => {
    const app = testApp(transcriptsRouter, { config: mockChatConfig(mock.origin) })
    const { body } = await create(app, createBody({ title: 'Teamsitzung' }))
    const row = fake.rows.find((candidate) => candidate.id === body.id)!
    row.subtitle = 'Meine Notiz'
    row.subtitleSource = 'manual'
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(row).toMatchObject({
      title: 'Teamsitzung',
      subtitle: 'Meine Notiz',
      subtitleSource: 'manual'
    })
  })

  it('writes a new subtitle on request, and 502 without a chat model', async () => {
    const { body } = await create(testApp(transcriptsRouter))
    const path = relative(TRANSCRIPTION_API.transcriptSubtitle(String(body.id)))
    const unavailable = await testApp(transcriptsRouter).request(path, { method: 'POST' })
    expect(unavailable.status).toBe(502)
    expect(await unavailable.json()).toMatchObject({ error: { code: 'module_unavailable' } })

    const app = testApp(transcriptsRouter, { config: mockChatConfig(mock.origin) })
    const response = await app.request(path, { method: 'POST' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      subtitle: 'Gespräch mit Anna, Ben über „Guten Tag, wir planen das Treffen“',
      subtitleSource: 'ai'
    })
    const bob = testApp(transcriptsRouter, { userId: 'bob', config: mockChatConfig(mock.origin) })
    expect((await bob.request(path, { method: 'POST' })).status).toBe(404)
  })
})
