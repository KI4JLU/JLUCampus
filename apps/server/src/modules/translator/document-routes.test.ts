import { FEATURE_KEYS, type FeatureKey } from '@justcampus/shared'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import {
  TRANSLATOR_DOCUMENT_ACTIVE_MAX,
  TRANSLATOR_DOCUMENT_MAX_BYTES,
  TRANSLATOR_DOCUMENT_TOO_LARGE
} from '@justcampus/shared'

import { ApiError } from '../../api.js'
import type { AppEnvironment } from '../types.js'
import { uploadDocument } from './deepl.js'
import { activeDocumentCount, findDocument } from './documents.js'
import { glossaryEntries } from './glossaries.js'
import { translatorApp } from './index.js'

vi.mock('./documents.js', () => ({
  findDocument: vi.fn(),
  activeDocumentCount: vi.fn(),
  findDocumentResult: vi.fn(),
  resultFilename: () => 'a_en.pdf',
  publicDocument: vi.fn(),
  documentExpiry: vi.fn(),
  listDocuments: vi.fn(),
  pollDocument: vi.fn(),
  recoverErrorMessage: vi.fn(async (row: unknown) => row),
  rememberJobGlossary: vi.fn(),
  startDocumentWorker: vi.fn()
}))
vi.mock('./deepl.js', () => ({
  uploadDocument: vi.fn(),
  DeepLRefusedError: class extends Error {}
}))
vi.mock('./glossaries.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./glossaries.js')>()),
  glossaryEntries: vi.fn(async () => [])
}))

const deleteState = vi.hoisted(() => ({ values: {} as Record<string, unknown> }))
vi.mock('../../db/index.js', () => ({
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        deleteState.values = values
        return { where: () => ({ returning: async () => [{ id: 'deleted' }] }) }
      }
    })
  }
}))

function app(userId: string, features: readonly FeatureKey[] = FEATURE_KEYS): Hono<AppEnvironment> {
  const testApp = new Hono<AppEnvironment>()
  testApp.use('*', async (context, next) => {
    context.set(
      'access',
      Promise.resolve({
        isAdmin: false,
        componentIds: new Set(['component']),
        features: new Set(features)
      })
    )
    context.set('session', { user: { id: userId } } as AppEnvironment['Variables']['session'])
    context.set('module', {
      type: 'translator',
      componentId: '00000000-0000-0000-0000-000000000001',
      config: {
        defaultTargetLanguage: 'en-gb',
        deeplApiUrl: null,
        llmBaseUrl: null,
        llmModels: [],
        llmProviderName: null,
        defaultEngine: null,
        documentsEnabled: true
      },
      secrets: { deeplApiKey: 'key', llmApiKey: null }
    })
    await next()
  })
  testApp.onError((error, context) => {
    if (error instanceof ApiError)
      return context.json(
        { error: { code: error.code, ...(error.issues ? { issues: error.issues } : {}) } },
        error.status
      )
    throw error
  })
  testApp.route('/', translatorApp)
  return testApp
}

const id = '123e4567-e89b-42d3-a456-426614174000'

describe('document routes', () => {
  function uploadForm(): FormData {
    const body = new FormData()
    body.set('file', new File(['hello'], 'note.txt'))
    body.set('target', 'en-gb')
    return body
  }

  it.each(['de', undefined])(
    'refuses glossary ids before loading entries or uploading, with source %s',
    async (source) => {
      vi.mocked(activeDocumentCount).mockResolvedValue(0)
      vi.mocked(uploadDocument).mockClear()
      vi.mocked(glossaryEntries).mockClear()
      const body = uploadForm()
      body.append('glossaryId', id)
      if (source) body.set('source', source)
      const response = await app(
        'glossary-denied',
        FEATURE_KEYS.filter((feature) => feature !== 'translator.glossaries')
      ).request('http://test/documents', { method: 'POST', body })
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: { code: 'forbidden' } })
      expect(glossaryEntries).not.toHaveBeenCalled()
      expect(uploadDocument).not.toHaveBeenCalled()
    }
  )

  it('allows glossary ids with permission', async () => {
    vi.mocked(activeDocumentCount).mockResolvedValue(0)
    vi.mocked(uploadDocument).mockClear()
    vi.mocked(glossaryEntries).mockClear()
    vi.mocked(uploadDocument).mockRejectedValueOnce(new Error('upstream unavailable'))
    const body = uploadForm()
    body.set('source', 'de')
    body.append('glossaryId', id)
    const response = await app('glossary-allowed').request('http://test/documents', {
      method: 'POST',
      body
    })
    expect(response.status).toBe(502)
    expect(glossaryEntries).toHaveBeenCalledWith(
      [id],
      '00000000-0000-0000-0000-000000000001',
      expect.any(Function)
    )
    expect(uploadDocument).toHaveBeenCalledTimes(1)
  })

  it('rejects a job over the guard before DeepL', async () => {
    vi.mocked(activeDocumentCount).mockResolvedValue(TRANSLATOR_DOCUMENT_ACTIVE_MAX)
    vi.mocked(uploadDocument).mockClear()
    const response = await app(
      'owner',
      FEATURE_KEYS.filter((feature) => feature !== 'translator.glossaries')
    ).request('http://test/documents', {
      method: 'POST',
      body: uploadForm()
    })
    expect(response.status).toBe(429)
    await expect(response.json()).resolves.toEqual({ error: { code: 'rate_limited' } })
    expect(uploadDocument).not.toHaveBeenCalled()
  })

  it('refuses a document far over 20 MB as one just over it', async () => {
    vi.mocked(activeDocumentCount).mockResolvedValue(0)
    vi.mocked(uploadDocument).mockClear()
    const issue = {
      error: {
        code: 'validation',
        issues: [{ path: ['file'], message: TRANSLATOR_DOCUMENT_TOO_LARGE }]
      }
    }
    for (const size of [TRANSLATOR_DOCUMENT_MAX_BYTES + 1, 21 * 1024 * 1024]) {
      const body = uploadForm()
      body.set('file', new File([new Uint8Array(size)], 'large.txt'))
      const response = await app('large').request('http://test/documents', {
        method: 'POST',
        body
      })
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual(issue)
    }
    expect(uploadDocument).not.toHaveBeenCalled()
  })

  it('takes a fourth parallel job, as HAWKI does', async () => {
    vi.mocked(activeDocumentCount).mockResolvedValue(3)
    vi.mocked(uploadDocument).mockClear()
    vi.mocked(uploadDocument).mockRejectedValueOnce(new Error('upstream unavailable'))
    const response = await app(
      'owner',
      FEATURE_KEYS.filter((feature) => feature !== 'translator.glossaries')
    ).request('http://test/documents', {
      method: 'POST',
      body: uploadForm()
    })
    expect(response.status).toBe(502)
    expect(uploadDocument).toHaveBeenCalledTimes(1)
  })

  it('counts an upload in flight against a parallel request', async () => {
    vi.mocked(activeDocumentCount).mockResolvedValue(TRANSLATOR_DOCUMENT_ACTIVE_MAX - 1)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.mocked(uploadDocument).mockImplementationOnce(async () => {
      await gate
      throw new Error('upstream unavailable')
    })
    const first = app('owner').request('http://test/documents', {
      method: 'POST',
      body: uploadForm()
    })
    await vi.waitFor(() => expect(uploadDocument).toHaveBeenCalledTimes(1))
    const second = await app('owner').request('http://test/documents', {
      method: 'POST',
      body: uploadForm()
    })
    expect(second.status).toBe(429)
    expect(uploadDocument).toHaveBeenCalledTimes(1)
    release()
    expect((await first).status).toBe(502)
  })

  it('soft-deletes and clears the result', async () => {
    const response = await app('owner').request(`http://test/documents/${id}`, { method: 'DELETE' })
    expect(response.status).toBe(204)
    expect(deleteState.values).toMatchObject({
      deletedAt: expect.any(Date),
      result: null,
      resultContentType: null
    })
    vi.mocked(findDocument).mockResolvedValue(undefined)
    const hidden = await app('owner').request(`http://test/documents/${id}`)
    expect(hidden.status).toBe(404)
  })

  it('answers 404 for another user’s job', async () => {
    vi.mocked(findDocument).mockImplementation(async (_id, _componentId, userId) =>
      userId === 'owner'
        ? ({ status: 'queued' } as Awaited<ReturnType<typeof findDocument>>)
        : undefined
    )
    const response = await app('other').request(`http://test/documents/${id}`)
    expect(response.status).toBe(404)
    expect(findDocument).toHaveBeenCalledWith(id, '00000000-0000-0000-0000-000000000001', 'other')
  })

  it('answers 409 before the translated file is stored', async () => {
    vi.mocked(findDocument).mockResolvedValue({ status: 'translating' } as Awaited<
      ReturnType<typeof findDocument>
    >)
    const response = await app('owner').request(`http://test/documents/${id}/download`)
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: { code: 'conflict' } })
  })
})
