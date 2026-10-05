import {
  TRANSCRIPTION_API,
  TRANSCRIPTION_BUILTIN_TEMPLATES,
  type TranscriptionTemplate
} from '@justcampus/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { json, testApp } from '../transcripts/testing.js'
import { templatesRouter } from './index.js'
import { BUILTIN_TEMPLATES, withSectionIds, type TemplateValues } from './store.js'

/** User templates in memory; `userId` null is an admin-wide one. */
const fake = vi.hoisted(() => ({
  rows: [] as Array<TranscriptionTemplate & { userId: string | null }>
}))

vi.mock('./store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./store.js')>()
  const strip = (
    row: TranscriptionTemplate & { userId?: string | null }
  ): TranscriptionTemplate => {
    const template = { ...row }
    delete template.userId
    return template
  }
  const usable =
    (userId: string) =>
    (row: { userId: string | null }): boolean =>
      row.userId === userId || row.userId === null
  return {
    ...actual,
    listTemplates: async (_componentId: string, userId: string) => [
      ...actual.BUILTIN_TEMPLATES,
      ...fake.rows.filter(usable(userId)).map(strip)
    ],
    findTemplate: async (_componentId: string, userId: string, id: string) => {
      const builtIn = actual.builtInTemplate(id)
      if (builtIn) return { template: builtIn, own: false }
      const row = fake.rows.find((candidate) => usable(userId)(candidate) && candidate.id === id)
      return row ? { template: strip(row), own: row.userId === userId } : null
    },
    insertTemplate: async (_componentId: string, userId: string, values: TemplateValues) => {
      const now = new Date().toISOString()
      const row = {
        ...values,
        structure: actual.withSectionIds(values.structure),
        id: crypto.randomUUID(),
        userId,
        builtIn: false,
        version: 1,
        outputFormatHints: null,
        createdAt: now,
        updatedAt: now
      }
      fake.rows.push(row)
      return strip(row)
    },
    updateTemplate: async (
      _componentId: string,
      userId: string,
      id: string,
      values: TemplateValues
    ) => {
      const row = fake.rows.find((candidate) => candidate.userId === userId && candidate.id === id)
      if (!row) return null
      Object.assign(row, values, {
        structure: actual.withSectionIds(values.structure),
        version: row.version + 1
      })
      return strip(row)
    },
    deleteTemplate: async (_componentId: string, userId: string, id: string) => {
      const before = fake.rows.length
      fake.rows = fake.rows.filter((row) => !(row.userId === userId && row.id === id))
      return fake.rows.length < before
    }
  }
})

beforeEach(() => {
  fake.rows = []
})

const relative = (path: string): string => path.replace('/api/modules/transcription', '')
const structure = [
  { type: 'heading', level: 1, text: 'Protokoll: {{title}}' },
  { type: 'divider' },
  { type: 'section', heading: 'Aufgaben', instruction: 'Liste die Aufgaben.' }
]

async function createTemplate(
  name = 'Mein Format',
  userId = 'alice'
): Promise<TranscriptionTemplate> {
  const response = await testApp(templatesRouter, { userId }).request(
    relative(TRANSCRIPTION_API.templates),
    json('POST', { id: null, name, structure })
  )
  expect(response.status).toBe(200)
  return (await response.json()) as TranscriptionTemplate
}

describe('built-in templates', () => {
  it('are kiChat’s five, verbatim, version 1 and read-only', () => {
    expect(BUILTIN_TEMPLATES.map((template) => template.id)).toEqual([
      'focus-group',
      'interview',
      'meeting-protocol',
      'mein-interview-format',
      'legacy'
    ])
    BUILTIN_TEMPLATES.forEach((template, index) => {
      const source = TRANSCRIPTION_BUILTIN_TEMPLATES[index]!
      expect(template).toMatchObject({
        name: source.name,
        description: source.description,
        structure: source.structure,
        builtIn: true,
        version: 1
      })
    })
  })

  it('gives sections ids without changing those already there', () => {
    const withIds = withSectionIds([
      { type: 'section', id: 'keep', heading: 'A', instruction: 'a' },
      { type: 'section', id: 'keep', heading: 'B', instruction: 'b' },
      { type: 'text', text: 'x' }
    ])
    expect(withIds[0]).toMatchObject({ id: 'keep' })
    expect(withIds[1]).toMatchObject({ type: 'section', heading: 'B' })
    expect((withIds[1] as { id: string }).id).not.toBe('keep')
    expect(withIds[2]).toEqual({ type: 'text', text: 'x' })
  })
})

describe('template routes', () => {
  it('lists the built-ins first, then the user’s own', async () => {
    await createTemplate('Mein Format')
    await createTemplate('Bobs Format', 'bob')
    const response = await testApp(templatesRouter).request(relative(TRANSCRIPTION_API.templates))
    const { templates } = (await response.json()) as { templates: TranscriptionTemplate[] }
    expect(templates.map((template) => template.name)).toEqual([
      'Fokusgruppe',
      'Interview',
      'Meeting-Protokoll',
      'Mein Interview-Format',
      'Standard-Protokoll',
      'Mein Format'
    ])
  })

  it('takes repeated names with new ids and keeps the block order', async () => {
    const first = await createTemplate('Gleich')
    const second = await createTemplate('Gleich')
    expect(first.id).not.toBe(second.id)
    expect(first.structure.map((block) => block.type)).toEqual(['heading', 'divider', 'section'])
    expect(first).toMatchObject({ builtIn: false, version: 1, description: '' })
  })

  it('raises the version on every change of one’s own template', async () => {
    const created = await createTemplate()
    const response = await testApp(templatesRouter).request(
      relative(TRANSCRIPTION_API.templates),
      json('POST', { id: created.id, name: 'Neu', structure: structure.slice(2) })
    )
    expect(await response.json()).toMatchObject({ id: created.id, name: 'Neu', version: 2 })
  })

  it('refuses blank names and empty structures', async () => {
    const app = testApp(templatesRouter)
    const path = relative(TRANSCRIPTION_API.templates)
    expect((await app.request(path, json('POST', { id: null, name: ' ', structure }))).status).toBe(
      400
    )
    expect(
      (await app.request(path, json('POST', { id: null, name: 'x', structure: [] }))).status
    ).toBe(400)
  })

  it('refuses changes to built-ins and admin-wide templates with 403', async () => {
    const app = testApp(templatesRouter)
    const change = await app.request(
      relative(TRANSCRIPTION_API.templates),
      json('POST', { id: 'interview', name: 'Meins', structure })
    )
    expect(change.status).toBe(403)
    const remove = await app.request(relative(TRANSCRIPTION_API.template('legacy')), {
      method: 'DELETE'
    })
    expect(remove.status).toBe(403)

    fake.rows.push({
      ...BUILTIN_TEMPLATES[0]!,
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      builtIn: true,
      userId: null
    })
    const shared = await app.request(
      relative(TRANSCRIPTION_API.template('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')),
      {
        method: 'DELETE'
      }
    )
    expect(shared.status).toBe(403)
  })

  it('keeps other users’ templates out of reach', async () => {
    const created = await createTemplate('Privat')
    const bob = testApp(templatesRouter, { userId: 'bob' })
    const change = await bob.request(
      relative(TRANSCRIPTION_API.templates),
      json('POST', { id: created.id, name: 'Übernommen', structure })
    )
    expect(change.status).toBe(404)
    expect(
      (await bob.request(relative(TRANSCRIPTION_API.template(created.id)), { method: 'DELETE' }))
        .status
    ).toBe(404)
    const list = (await (await bob.request(relative(TRANSCRIPTION_API.templates))).json()) as {
      templates: TranscriptionTemplate[]
    }
    expect(list.templates.some((template) => template.id === created.id)).toBe(false)
  })

  it('deletes one’s own template once, then answers 404', async () => {
    const created = await createTemplate()
    const app = testApp(templatesRouter)
    const path = relative(TRANSCRIPTION_API.template(created.id))
    expect((await app.request(path, { method: 'DELETE' })).status).toBe(204)
    expect((await app.request(path, { method: 'DELETE' })).status).toBe(404)
  })
})
