import { FEATURE_KEYS } from '@justcampus/shared'
import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../../api.js'
import type { AppEnvironment } from '../types.js'
import {
  deeplBaseUrl,
  DeepLHttpError,
  deeplDetectedLanguage,
  deeplSourceLanguage,
  downloadDocument,
  glossaryTsv,
  deeplTargetLanguage,
  hasMarkup,
  translateWithDeepL
} from './deepl.js'
import { translatorApp } from './index.js'

afterEach(() => vi.unstubAllGlobals())

describe('DeepL', () => {
  it('chooses the free endpoint and maps languages', () => {
    expect(deeplBaseUrl(null, 'free:fx')).toBe('https://api-free.deepl.com')
    expect(deeplBaseUrl(null, 'paid')).toBe('https://api.deepl.com')
    expect(deeplBaseUrl('https://custom.example.test/', 'free:fx')).toBe(
      'https://custom.example.test'
    )
    expect(deeplTargetLanguage('en-gb')).toBe('EN-GB')
    expect(deeplTargetLanguage('en-us')).toBe('EN-US')
    expect(deeplTargetLanguage('pt')).toBe('PT-PT')
    expect(deeplTargetLanguage('zh')).toBe('ZH-HANS')
    expect(deeplSourceLanguage('en-us')).toBe('EN')
    expect(deeplDetectedLanguage('EN')).toBe('en-gb')
    expect(deeplDetectedLanguage('DE')).toBe('de')
  })

  it('sends the sentences with text and keeps blank ones', async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        translations: [
          { text: 'Hallo.', detected_source_language: 'EN' },
          { text: 'Welt.', detected_source_language: 'EN' }
        ]
      })
    )
    vi.stubGlobal('fetch', fetch)

    await expect(
      translateWithDeepL(
        {
          text: ['Hello. ', '\n', 'World.'],
          source: null,
          target: 'de',
          formality: 'formal',
          style: null,
          tone: null,
          glossaryIds: []
        },
        null,
        'free:fx',
        new AbortController().signal
      )
    ).resolves.toEqual({ text: ['Hallo.', '\n', 'Welt.'], detectedSource: 'en-gb' })
    expect(fetch).toHaveBeenCalledWith(
      'https://api-free.deepl.com/v2/translate',
      expect.objectContaining({
        redirect: 'error',
        body: JSON.stringify({
          text: ['Hello. ', 'World.'],
          target_lang: 'DE',
          formality: 'prefer_more'
        })
      })
    )
  })

  it('sends the source as HAWKI does and keeps markup as HTML', async () => {
    const fetch = vi.fn(async () =>
      Response.json({ translations: [{ text: 'Hi.' }, { text: '<b>World</b> &amp; you.' }] })
    )
    vi.stubGlobal('fetch', fetch)

    await translateWithDeepL(
      {
        text: ['Hallo & tschüss. ', '<b>Welt</b> & du.'],
        source: 'en-gb',
        target: 'de',
        formality: 'default',
        style: null,
        tone: null,
        glossaryIds: []
      },
      null,
      'free:fx',
      new AbortController().signal
    )
    expect(
      JSON.parse((fetch.mock.calls[0] as unknown as [string, { body: string }])[1].body)
    ).toEqual({
      text: ['Hallo & tschüss. ', '<b>Welt</b> & du.'],
      target_lang: 'DE',
      source_lang: 'EN-GB',
      tag_handling: 'html'
    })
    expect(hasMarkup('3 < 5 und 6 > 4')).toBe(false)
    expect(hasMarkup('Das ist <3 für dich')).toBe(false)
  })

  it('writes glossary terms as DeepL TSV', () => {
    expect(
      glossaryTsv([
        { source: 'Prüfungs\tamt', target: 'Examinations Office' },
        { source: 'Prüfungs amt', target: 'Other' },
        { source: ' ', target: 'x' }
      ])
    ).toBe('Prüfungs amt\tExaminations Office')
  })

  it('maps malformed upstream responses to module_unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ translations: [] }))
    )
    const app = new Hono<AppEnvironment>()
    app.use('*', async (context, next) => {
      context.set(
        'access',
        Promise.resolve({
          isAdmin: false,
          componentIds: new Set(['component']),
          features: new Set(FEATURE_KEYS)
        })
      )
      context.set('session', { user: { id: 'user' } } as AppEnvironment['Variables']['session'])
      context.set('module', {
        type: 'translator',
        componentId: 'component',
        config: {
          defaultTargetLanguage: 'en-gb',
          deeplApiUrl: null,
          llmBaseUrl: null,
          llmModels: [],
          llmProviderName: null,
          defaultEngine: null,
          documentsEnabled: false
        },
        secrets: { deeplApiKey: 'key', llmApiKey: null }
      })
      await next()
    })
    app.onError((error, context) => {
      if (error instanceof ApiError) {
        return context.json({ error: { code: error.code, message: error.message } }, error.status)
      }
      throw error
    })
    app.route('/', translatorApp)

    const response = await app.request('http://test/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: ['Hello'], source: null, target: 'de' })
    })
    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'module_unavailable' } })
  })

  it('exposes the DeepL HTTP status on failed result downloads', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 404 }))
    )
    await expect(
      downloadDocument('doc', 'secret', null, 'key', new AbortController().signal)
    ).rejects.toMatchObject({ status: 404 })
    expect(new DeepLHttpError(429).message).toBe('DeepL returned 429')
  })
})
