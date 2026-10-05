import { TRANSCRIPTION_API, type TranscriptionTemplate } from '@justcampus/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { BUILTIN_TEMPLATES } from '../templates/store.js'
import type { TranscriptRow } from '../transcripts/store.js'
import {
  json,
  mockChatConfig,
  startUpstreamMock,
  testApp,
  type RunningMock
} from '../transcripts/testing.js'
import { summariesRouter } from './index.js'
import type { PreviewKey, StoredSummary, SummaryKey } from './store.js'

const fake = vi.hoisted(() => ({
  transcripts: [] as TranscriptRow[],
  templates: [] as Array<TranscriptionTemplate & { userId: string }>,
  summaries: new Map<string, StoredSummary>(),
  previews: new Map<string, Record<string, string>>(),
  remembered: [] as Array<[string, string]>
}))

vi.mock('../transcripts/store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../transcripts/store.js')>()),
  findTranscript: async (_componentId: string, userId: string, id: string) =>
    fake.transcripts.find((row) => row.userId === userId && row.id === id) ?? null,
  rememberSummaryTemplate: async (id: string, templateId: string) => {
    fake.remembered.push([id, templateId])
  }
}))

vi.mock('../templates/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../templates/store.js')>()
  return {
    ...actual,
    findTemplate: async (_componentId: string, userId: string, id: string) => {
      const builtIn = actual.builtInTemplate(id)
      if (builtIn) return { template: builtIn, own: false }
      const row = fake.templates.find(
        (candidate) => candidate.userId === userId && candidate.id === id
      )
      return row ? { template: row, own: true } : null
    }
  }
})

vi.mock('./store.js', () => {
  const summaryKey = (key: SummaryKey): string => JSON.stringify(key)
  const previewKey = (key: PreviewKey): string => JSON.stringify(key)
  return {
    findSummary: async (key: SummaryKey) => fake.summaries.get(summaryKey(key)) ?? null,
    storeSummary: async (key: SummaryKey, markdown: string, generatedAt: Date) => {
      for (const stored of [...fake.summaries.keys()]) {
        const other = JSON.parse(stored) as SummaryKey
        if (other.transcriptId === key.transcriptId && other.templateId === key.templateId) {
          fake.summaries.delete(stored)
        }
      }
      fake.summaries.set(summaryKey(key), { markdown, generatedAt })
    },
    findPreviews: async (key: PreviewKey) => fake.previews.get(previewKey(key)) ?? {},
    storePreviews: async (key: PreviewKey, sections: Record<string, string>) => {
      if (Object.keys(sections).length === 0) return
      fake.previews.set(previewKey(key), { ...fake.previews.get(previewKey(key)), ...sections })
    }
  }
})

const transcriptId = '11111111-1111-4111-8111-111111111111'
const ownTemplateId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const relative = (path: string): string => path.replace('/api/modules/transcription', '')
const summaries = relative(TRANSCRIPTION_API.summaries)
const preview = relative(TRANSCRIPTION_API.summaryPreview)

function transcript(overrides: Partial<TranscriptRow> = {}): TranscriptRow {
  const date = new Date('2026-10-04T08:00:00Z')
  return {
    id: transcriptId,
    componentId: 'component',
    userId: 'alice',
    idempotencyKey: '22222222-2222-4222-8222-222222222222',
    title: 'Teamsitzung',
    subtitle: null,
    subtitleSource: null,
    language: 'de',
    duration: 600,
    model: null,
    provider: null,
    originalFilename: 'a.wav',
    fileSize: 1,
    segments: [
      {
        id: 0,
        start: 0,
        end: 3,
        text: 'Mein Name ist Herr Meier.',
        speaker: 'Anna',
        redactions: [{ start: 14, end: 24 }]
      },
      {
        id: 1,
        start: 3,
        end: 6,
        text: 'Treffen am Montag um 10 Uhr.',
        speaker: 'Ben',
        redactions: []
      }
    ],
    words: [],
    text: '',
    sourceFiles: [],
    speakerColors: {},
    summaryTemplateId: null,
    revision: 1,
    userLocale: 'de',
    createdAt: date,
    updatedAt: date,
    expiresAt: null,
    ...overrides
  }
}

let mock: RunningMock
let chatCalls: number

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  mock = await startUpstreamMock()
  const realFetch = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    if (String(input).endsWith('/chat/completions')) chatCalls += 1
    return realFetch(input, init)
  })
})

afterAll(async () => {
  await mock.close()
  vi.restoreAllMocks()
})

beforeEach(() => {
  fake.transcripts = [transcript()]
  fake.templates = [
    {
      ...BUILTIN_TEMPLATES[1]!,
      id: ownTemplateId,
      name: 'Eigene',
      builtIn: false,
      version: 3,
      userId: 'alice'
    }
  ]
  fake.summaries.clear()
  fake.previews.clear()
  fake.remembered = []
  chatCalls = 0
})

const app = (options: Parameters<typeof testApp>[1] = {}): ReturnType<typeof testApp> =>
  testApp(summariesRouter, { config: mockChatConfig(mock.origin), ...options })

async function summarise(
  body: Record<string, unknown>,
  options: Parameters<typeof testApp>[1] = {}
): Promise<{ status: number; body: { summary: Record<string, unknown> | null } }> {
  const response = await app(options).request(summaries, json('POST', body))
  return {
    status: response.status,
    body: (await response.json()) as { summary: Record<string, unknown> | null }
  }
}

describe('summaries', () => {
  it('fills the template from the saved transcript, redactions applied, and stores it', async () => {
    const { status, body } = await summarise({ transcriptId, templateId: 'interview' })
    expect(status).toBe(200)
    expect(body.summary).toMatchObject({
      templateId: 'interview',
      templateVersion: 1,
      transcriptRevision: 1,
      model: 'mock-chat',
      cached: false
    })
    const markdown = String(body.summary!.markdown)
    expect(markdown).toMatch(
      /^# Interview: Teamsitzung\n\nDatum: 04\.10\.2026 · Teilnehmer: Anna, Ben\n\n## Kernaussagen\n\n- 2 Redebeiträge von Anna, Ben\./
    )
    expect(markdown).toContain('## Zitate')
    expect(markdown).toContain('## Themen')
    expect(markdown).toContain('Mein Name ist [AUSGEBLENDET].')
    expect(markdown).not.toContain('Meier')
    expect(markdown).not.toMatch(/\{\{/)
    expect(chatCalls).toBe(3)
    expect(fake.remembered).toEqual([[transcriptId, 'interview']])
  })

  it('answers the stored summary until forced, and checks without generating', async () => {
    expect(
      (await summarise({ transcriptId, templateId: 'interview', checkOnly: true })).body
    ).toEqual({
      summary: null
    })
    expect(chatCalls).toBe(0)
    const first = await summarise({ transcriptId, templateId: 'interview' })
    const cached = await summarise({ transcriptId, templateId: 'interview' })
    expect(cached.body.summary).toMatchObject({
      markdown: first.body.summary!.markdown,
      cached: true
    })
    const checked = await summarise({ transcriptId, templateId: 'interview', checkOnly: true })
    expect(checked.body.summary).toMatchObject({ cached: true })
    expect(chatCalls).toBe(3)
    const forced = await summarise({ transcriptId, templateId: 'interview', forceRegenerate: true })
    expect(forced.body.summary).toMatchObject({ cached: false })
    expect(chatCalls).toBe(6)
  })

  it('goes stale with a new revision, another template version or another model', async () => {
    await summarise({ transcriptId, templateId: ownTemplateId })
    expect(
      (await summarise({ transcriptId, templateId: ownTemplateId, checkOnly: true })).body.summary
    ).toMatchObject({
      templateVersion: 3
    })
    expect(
      (
        await summarise({
          transcriptId,
          templateId: ownTemplateId,
          checkOnly: true,
          model: 'mock-prose'
        })
      ).body
    ).toEqual({ summary: null })
    fake.templates[0]!.version = 4
    expect(
      (await summarise({ transcriptId, templateId: ownTemplateId, checkOnly: true })).body
    ).toEqual({
      summary: null
    })
    fake.templates[0]!.version = 3
    fake.transcripts[0]!.revision = 2
    expect(
      (await summarise({ transcriptId, templateId: ownTemplateId, checkOnly: true })).body
    ).toEqual({
      summary: null
    })
  })

  it('names the title it filled in, and goes stale when a generated title replaces it', async () => {
    const first = await summarise({ transcriptId, templateId: 'interview' })
    expect(first.body.summary).toMatchObject({
      transcriptRevision: 1,
      transcriptTitle: 'Teamsitzung'
    })
    expect(
      (await summarise({ transcriptId, templateId: 'interview', checkOnly: true })).body.summary
    ).toMatchObject({ transcriptTitle: 'Teamsitzung', cached: true })
    // The chat model's title arrives after saving, without a new revision.
    fake.transcripts[0]!.title = 'Planung der Klausurtagung'
    expect(
      (await summarise({ transcriptId, templateId: 'interview', checkOnly: true })).body
    ).toEqual({ summary: null })
    const second = await summarise({ transcriptId, templateId: 'interview' })
    expect(second.body.summary).toMatchObject({
      transcriptRevision: 1,
      transcriptTitle: 'Planung der Klausurtagung',
      cached: false
    })
    expect(String(second.body.summary!.markdown)).toMatch(/^# Interview: Planung der Klausurtagung/)
  })

  it('summarises unsaved text without storing it', async () => {
    const { body } = await summarise({
      transcriptText: 'Anna: Hallo [AUSGEBLENDET].\nBen: Tschüss.',
      templateId: 'focus-group'
    })
    expect(body.summary).toMatchObject({
      transcriptRevision: null,
      transcriptTitle: null,
      cached: false
    })
    expect(String(body.summary!.markdown)).toMatch(
      /^# Fokusgruppe: Transkript\n\nDatum: \d\d\.\d\d\.\d{4} · Teilnehmer: Anna, Ben/
    )
    expect(fake.summaries.size).toBe(0)
    expect(
      (
        await summarise({
          transcriptText: 'Anna: Hallo',
          templateId: 'focus-group',
          checkOnly: true
        })
      ).body
    ).toEqual({ summary: null })
  })

  it('uses only listed models and parses prose answers', async () => {
    const unlisted = await summarise({ transcriptId, templateId: 'legacy', model: 'gpt-expensive' })
    expect(unlisted.body.summary).toMatchObject({ model: 'mock-chat' })
    const prose = await summarise({ transcriptId, templateId: 'legacy', model: 'mock-prose' })
    expect(prose.body.summary).toMatchObject({ model: 'mock-prose' })
    expect(String(prose.body.summary!.markdown)).toContain('Das Gespräch beginnt mit')
  })

  it('keeps other users’ transcripts and templates out of reach', async () => {
    const bob = { userId: 'bob' }
    expect((await summarise({ transcriptId, templateId: 'interview' }, bob)).status).toBe(404)
    expect(
      (await summarise({ transcriptText: 'x: y', templateId: ownTemplateId }, bob)).status
    ).toBe(404)
    expect((await summarise({ transcriptId, templateId: 'unknown' })).status).toBe(404)
    expect(chatCalls).toBe(0)
  })

  it('reports a missing or failing chat model as unavailable', async () => {
    const none = await testApp(summariesRouter).request(
      summaries,
      json('POST', { transcriptId, templateId: 'interview' })
    )
    expect(none.status).toBe(502)
    const checked = await testApp(summariesRouter).request(
      summaries,
      json('POST', { transcriptId, templateId: 'interview', checkOnly: true })
    )
    expect(await checked.json()).toEqual({ summary: null })
    const failing = await summarise({ transcriptId, templateId: 'interview', model: 'mock-fail' })
    expect(failing.status).toBe(502)
    expect(fake.summaries.size).toBe(0)
  })

  it('needs a transcript or text', async () => {
    expect((await summarise({ transcriptText: '  ', templateId: 'interview' })).status).toBe(400)
    fake.transcripts = [transcript({ segments: [] })]
    expect((await summarise({ transcriptId, templateId: 'interview' })).status).toBe(400)
  })
})

describe('section previews', () => {
  const sections = [
    { id: 'a', heading: 'Kernaussagen', instruction: 'Fasse zusammen.' },
    { id: 'b', heading: 'Aufgaben', instruction: 'Liste Aufgaben.' }
  ]

  async function previewOf(
    body: Record<string, unknown>,
    options: Parameters<typeof testApp>[1] = {}
  ): Promise<{ status: number; body: Record<string, Record<string, string>> }> {
    const response = await app(options).request(preview, json('POST', body))
    return {
      status: response.status,
      body: (await response.json()) as Record<string, Record<string, string>>
    }
  }

  it('generates the sections sent and answers them from the store next time', async () => {
    const first = await previewOf({ transcriptId, sections })
    expect(first.status).toBe(200)
    expect(Object.keys(first.body.results!).sort()).toEqual(['a', 'b'])
    expect(first.body.results!.a).toContain('Mein Name ist [AUSGEBLENDET].')
    expect(first.body.errors).toEqual({})
    expect(chatCalls).toBe(2)

    const again = await previewOf({ transcriptId, sections })
    expect(again.body.results).toEqual(first.body.results)
    expect(chatCalls).toBe(2)
  })

  it('regenerates and answers only stale sections', async () => {
    await previewOf({ transcriptId, sections })
    const changed = [sections[0]!, { ...sections[1]!, instruction: 'Liste offene Aufgaben.' }]
    const stale = await previewOf({ transcriptId, sections: changed, staleSectionIds: ['b'] })
    expect(Object.keys(stale.body.results!)).toEqual(['b'])
    expect(chatCalls).toBe(3)
    const cached = await previewOf({ transcriptId, sections: changed })
    expect(Object.keys(cached.body.results!).sort()).toEqual(['a', 'b'])
    expect(chatCalls).toBe(3)
  })

  it('reports failed sections per section', async () => {
    const failed = await previewOf({ transcriptId, sections, model: 'mock-fail' })
    expect(failed.status).toBe(200)
    expect(failed.body.results).toEqual({})
    expect(Object.keys(failed.body.errors!).sort()).toEqual(['a', 'b'])
    expect(fake.previews.size).toBe(0)
  })

  it('previews unsaved text without storing it, and refuses repeated ids', async () => {
    const unsaved = await previewOf({
      transcriptText: 'Anna: Hallo.',
      sections: sections.slice(0, 1)
    })
    expect(unsaved.body.results!.a).toContain('1 Redebeiträge von Anna.')
    expect(fake.previews.size).toBe(0)
    const repeated = await previewOf({ transcriptId, sections: [sections[0], sections[0]] })
    expect(repeated.status).toBe(400)
    expect((await previewOf({ transcriptId, sections }, { userId: 'bob' })).status).toBe(404)
  })
})
