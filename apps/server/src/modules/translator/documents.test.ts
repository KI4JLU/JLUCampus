import { FEATURE_KEYS } from '@justcampus/shared'
import { Hono } from 'hono'
import { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../../api.js'
import type { AppEnvironment } from '../types.js'
import {
  documentError,
  DocumentResultTooLargeError,
  documentStatus,
  downloadDocument,
  readLimited,
  uploadDocument
} from './deepl.js'
import { activeDocumentCount, resultFilename } from './documents.js'
import { translatorApp } from './index.js'

afterEach(() => vi.unstubAllGlobals())

const quotaWhere = vi.hoisted(() => [] as SQL[])
vi.mock('../../db/index.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (condition: SQL) => {
          quotaWhere.push(condition)
          return Promise.resolve([{ value: 2 }])
        }
      })
    })
  }
}))

function app(enabled: boolean): Hono<AppEnvironment> {
  const testApp = new Hono<AppEnvironment>()
  testApp.use('*', async (context, next) => {
    context.set(
      'access',
      Promise.resolve({
        isAdmin: false,
        componentIds: new Set(['component']),
        features: new Set(FEATURE_KEYS)
      })
    )
    context.set('session', { user: { id: 'owner' } } as AppEnvironment['Variables']['session'])
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
        documentsEnabled: enabled
      },
      secrets: { deeplApiKey: 'key', llmApiKey: null }
    })
    await next()
  })
  testApp.onError((error, context) => {
    if (error instanceof ApiError)
      return context.json({ error: { code: error.code } }, error.status)
    throw error
  })
  testApp.route('/', translatorApp)
  return testApp
}

describe('DeepL documents', () => {
  it('counts only running jobs, with no daily quota', async () => {
    quotaWhere.length = 0
    await expect(activeDocumentCount('owner')).resolves.toBe(2)
    expect(quotaWhere).toHaveLength(1)
    const active = new PgDialect().sqlToQuery(quotaWhere[0]!).sql
    expect(active).toContain('"deleted_at" is null')
    expect(active).toContain('"status" in')
    expect(active).not.toContain('"created_at"')
  })

  it('sends multipart fields and maps the status and result', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ document_id: 'doc', document_key: 'secret' }))
      .mockResolvedValueOnce(
        Response.json({
          document_id: 'doc',
          status: 'error',
          error_message: 'Source and target language are equal'
        })
      )
      .mockResolvedValueOnce(
        new Response('translated', { headers: { 'content-type': 'application/pdf' } })
      )
    vi.stubGlobal('fetch', fetch)
    const signal = new AbortController().signal
    await expect(
      uploadDocument(
        new File(['hi'], 'Bericht.docx'),
        { source: null, target: 'en-gb', formality: 'formal' },
        null,
        'key',
        signal
      )
    ).resolves.toEqual({ document_id: 'doc', document_key: 'secret' })
    const [url, options] = fetch.mock.calls[0]!
    expect(url).toBe('https://api.deepl.com/v2/document')
    expect(options.redirect).toBe('error')
    expect(options.body.get('file').name).toBe('Bericht.docx')
    expect(options.body.get('target_lang')).toBe('EN-GB')
    expect(options.body.get('source_lang')).toBeNull()
    expect(options.body.get('formality')).toBe('prefer_more')
    const status = await documentStatus('doc', 'secret', null, 'key', signal)
    expect(documentError(status.error_message)).toBe('same_language')
    expect(documentError('Other failure')).toBe('failed')
    expect(fetch.mock.calls[1]![1].body).toBe('{"document_key":"secret"}')
    await expect(downloadDocument('doc', 'secret', null, 'key', signal)).resolves.toMatchObject({
      bytes: Buffer.from('translated'),
      contentType: 'application/pdf'
    })
    expect(resultFilename('Bericht.docx', 'en')).toBe('Bericht_en.docx')
    expect(resultFilename('r9-pruefung.doc', 'en-gb')).toBe('r9-pruefung_en-gb.docx')
    expect(resultFilename('alt.htm', 'en-gb')).toBe('alt_en-gb.htm')
  })

  it('sends an explicit source and informal formality', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ document_id: 'doc', document_key: 'secret' })
    )
    vi.stubGlobal('fetch', fetch)
    await uploadDocument(
      new File(['hello'], 'note.txt'),
      { source: 'de', target: 'fr', formality: 'informal' },
      null,
      'key',
      new AbortController().signal
    )
    const body = fetch.mock.calls[0]![1]!.body as FormData
    expect(body.get('source_lang')).toBe('DE')
    expect(body.get('target_lang')).toBe('FR')
    expect(body.get('formality')).toBe('prefer_less')
  })

  it('hides documents when disabled', async () => {
    const response = await app(false).request('http://test/documents')
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: { code: 'not_found' } })
  })

  it('hides documents when disabled, before the body limit looks at an upload', async () => {
    const form = new FormData()
    form.set('file', new File([new Uint8Array(21 * 1024 * 1024)], 'a.pdf'))
    const response = await app(false).request('http://test/documents', {
      method: 'POST',
      body: form
    })
    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: { code: 'not_found' } })
  })

  it('reads a result up to the limit', async () => {
    await expect(readLimited(new Response('abc'), 3)).resolves.toEqual(Buffer.from('abc'))
  })

  it('refuses a result declared larger than the limit', async () => {
    const response = new Response('abcd', { headers: { 'content-length': '4' } })
    await expect(readLimited(response, 3)).rejects.toBeInstanceOf(DocumentResultTooLargeError)
  })

  it('refuses a result that streams past the limit without declaring its size', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2))
        controller.enqueue(new Uint8Array(2))
        controller.close()
      }
    })
    await expect(readLimited(new Response(stream), 3)).rejects.toBeInstanceOf(
      DocumentResultTooLargeError
    )
  })

  it.each([
    ['missing', new FormData()],
    [
      'empty',
      (() => {
        const form = new FormData()
        form.set('file', new File([], 'a.pdf'))
        return form
      })()
    ],
    [
      'type',
      (() => {
        const form = new FormData()
        form.set('file', new File(['x'], 'a.exe'))
        return form
      })()
    ],
    [
      'size',
      (() => {
        const form = new FormData()
        form.set('file', new File([new Uint8Array(20 * 1024 * 1024 + 1)], 'a.pdf'))
        return form
      })()
    ]
  ])('rejects %s upload', async (_name, body) => {
    const response = await app(true).request('http://test/documents', { method: 'POST', body })
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'validation' } })
  })
})
