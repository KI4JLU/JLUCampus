import { TRANSCRIPTION_API, type TranscriptionFormat } from '@justcampus/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { json, testApp } from '../transcripts/testing.js'
import { formatsRouter } from './index.js'
import { uniqueFormatName, type FormatValues } from './store.js'

/** The store as rows in memory, owned per user as in the SQL. */
const fake = vi.hoisted(() => ({
  rows: [] as Array<TranscriptionFormat & { userId: string }>,
  clock: 0
}))

vi.mock('./store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./store.js')>()
  const strip = (row: TranscriptionFormat & { userId?: string }): TranscriptionFormat => {
    const format = { ...row }
    delete format.userId
    return format
  }
  return {
    ...actual,
    listFormats: async (_componentId: string, userId: string) =>
      fake.rows.filter((row) => row.userId === userId).map(strip),
    saveFormat: async (
      _componentId: string,
      userId: string,
      id: string | null,
      values: FormatValues
    ) => {
      const mine = fake.rows.filter((row) => row.userId === userId)
      if (id !== null && !mine.some((row) => row.id === id)) return null
      const name = actual.uniqueFormatName(
        values.name,
        mine.filter((row) => row.id !== id).map((row) => row.name)
      )
      const now = new Date(Date.UTC(2026, 9, 4, 10, 0, fake.clock++)).toISOString()
      if (id === null) {
        const row = {
          ...values,
          name,
          id: crypto.randomUUID(),
          userId,
          createdAt: now,
          updatedAt: now
        }
        fake.rows.push(row)
        return strip(row)
      }
      const row = mine.find((candidate) => candidate.id === id)!
      Object.assign(row, values, { name, updatedAt: now })
      return strip(row)
    },
    deleteFormat: async (_componentId: string, userId: string, id: string) => {
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
const flags = {
  speakers: true,
  timestamps: false,
  avatars: false,
  bubbles: true,
  anonymize: true,
  order: 'speaker'
}

describe('uniqueFormatName', () => {
  it('numbers names another format has in any case, as kiChat', () => {
    expect(uniqueFormatName('Interview', [])).toBe('Interview')
    expect(uniqueFormatName('Interview', ['interview'])).toBe('Interview (1)')
    expect(uniqueFormatName('Interview', ['Interview', 'Interview (1)'])).toBe('Interview (2)')
    expect(uniqueFormatName('x'.repeat(100), ['x'.repeat(100)])).toBe(`${'x'.repeat(96)} (1)`)
  })
})

describe('format routes', () => {
  it('creates, numbers duplicates, updates by id and lists the user’s formats', async () => {
    const app = testApp(formatsRouter)
    const path = relative(TRANSCRIPTION_API.formats)
    const created = (await (
      await app.request(path, json('POST', { id: null, name: ' Lesefassung ', ...flags }))
    ).json()) as TranscriptionFormat
    expect(created).toMatchObject({ name: 'Lesefassung', ...flags })

    const duplicate = await app.request(
      path,
      json('POST', { id: null, name: 'LESEFASSUNG', ...flags })
    )
    expect(await duplicate.json()).toMatchObject({ name: 'LESEFASSUNG (1)' })

    const renamed = await app.request(
      path,
      json('POST', { id: created.id, name: 'Lesefassung', ...flags, anonymize: false })
    )
    expect(await renamed.json()).toMatchObject({
      id: created.id,
      name: 'Lesefassung',
      anonymize: false
    })

    const list = (await (await app.request(path)).json()) as { formats: TranscriptionFormat[] }
    expect(list.formats.map((format) => format.name)).toEqual(['Lesefassung', 'LESEFASSUNG (1)'])
    const bob = await testApp(formatsRouter, { userId: 'bob' }).request(path)
    expect(await bob.json()).toEqual({ formats: [] })
  })

  it('requires a name and known flags', async () => {
    const app = testApp(formatsRouter)
    const path = relative(TRANSCRIPTION_API.formats)
    expect((await app.request(path, json('POST', { id: null, name: '  ', ...flags }))).status).toBe(
      400
    )
    expect(
      (await app.request(path, json('POST', { id: null, name: 'x', ...flags, order: 'random' })))
        .status
    ).toBe(400)
  })

  it('keeps other users’ formats out of reach', async () => {
    const path = relative(TRANSCRIPTION_API.formats)
    const created = (await (
      await testApp(formatsRouter).request(
        path,
        json('POST', { id: null, name: 'Meins', ...flags })
      )
    ).json()) as TranscriptionFormat
    const bob = testApp(formatsRouter, { userId: 'bob' })
    const update = await bob.request(
      path,
      json('POST', { id: created.id, name: 'Seins', ...flags })
    )
    expect(update.status).toBe(404)
    const remove = await bob.request(relative(TRANSCRIPTION_API.format(created.id)), {
      method: 'DELETE'
    })
    expect(remove.status).toBe(404)
    expect(fake.rows).toHaveLength(1)
  })

  it('deletes once, then answers 404', async () => {
    const app = testApp(formatsRouter)
    const created = (await (
      await app.request(
        relative(TRANSCRIPTION_API.formats),
        json('POST', { id: null, name: 'Weg', ...flags })
      )
    ).json()) as TranscriptionFormat
    const path = relative(TRANSCRIPTION_API.format(created.id))
    expect((await app.request(path, { method: 'DELETE' })).status).toBe(204)
    expect((await app.request(path, { method: 'DELETE' })).status).toBe(404)
    expect(
      (await app.request(relative(TRANSCRIPTION_API.format('7')), { method: 'DELETE' })).status
    ).toBe(404)
  })
})
