import { FEATURE_KEYS, type FeatureKey } from '@justcampus/shared'
import { TRANSLATOR_REQUESTS_PER_MINUTE, TRANSLATOR_THROTTLED_MESSAGE } from '@justcampus/shared'
import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError } from '../../api.js'
import type { AppEnvironment } from '../types.js'
import { glossaryEntries } from './glossaries.js'
import { translatorAdminApp, translatorApp } from './index.js'

vi.mock('./glossaries.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./glossaries.js')>()),
  glossaryEntries: vi.fn(async () => [])
}))

function testApp(
  routes: Hono<AppEnvironment>,
  secrets = { deeplApiKey: 'key' as string | null, llmApiKey: null as string | null },
  userId = 'user',
  features: readonly FeatureKey[] = FEATURE_KEYS
): Hono<AppEnvironment> {
  const app = new Hono<AppEnvironment>()
  app.use('*', async (context, next) => {
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
      secrets
    })
    await next()
  })
  app.onError((error, context) => {
    if (error instanceof ApiError) {
      return context.json({ error: { code: error.code, message: error.message } }, error.status)
    }
    throw error
  })
  app.route('/', routes)
  return app
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('translator routes', () => {
  const glossaryId = '123e4567-e89b-42d3-a456-426614174000'
  const withoutGlossaries = FEATURE_KEYS.filter((feature) => feature !== 'translator.glossaries')
  const post = (
    app: Hono<AppEnvironment>,
    path: string,
    glossaryIds?: string[]
  ): Promise<Response> =>
    Promise.resolve(
      app.request(`http://test${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: ['Hallo'],
          source: 'de',
          target: 'en-gb',
          engine: 'deepl',
          glossaryIds
        })
      })
    )

  it.each(['/translate', '/rephrase'])(
    'refuses known glossary ids on %s before loading entries or calling upstream',
    async (path) => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      const app = testApp(translatorApp, undefined, 'glossary-denied', withoutGlossaries)
      const response = await post(app, path, [glossaryId])
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ error: { code: 'forbidden' } })
      expect(glossaryEntries).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['/translate', undefined],
    ['/translate', []],
    ['/rephrase', undefined],
    ['/rephrase', []]
  ] as const)('allows %s without glossary ids after revocation (%j)', async (path, ids) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ translations: [{ text: 'Hello' }], improvements: [{ text: 'Hello' }] })
      )
    )
    const app = testApp(translatorApp, undefined, 'glossary-empty', withoutGlossaries)
    expect((await post(app, path, ids ? [...ids] : undefined)).status).toBe(200)
  })

  it.each(['/translate', '/rephrase'])(
    'allows glossary ids on %s with permission',
    async (path) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          Response.json({ translations: [{ text: 'Hello' }], improvements: [{ text: 'Hello' }] })
        )
      )
      expect((await post(testApp(translatorApp), path, [glossaryId])).status).toBe(200)
      expect(glossaryEntries).toHaveBeenCalledWith([glossaryId], 'component', expect.any(Function))
    }
  )

  it('rejects a DeepL rephrase request that combines style and tone', async () => {
    const app = testApp(translatorApp)

    const response = await app.request('http://test/rephrase', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hello', engine: 'deepl', style: 'business', tone: 'friendly' })
    })
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'validation' } })
  })
})

describe('the translator throttle', () => {
  const post = (app: Hono<AppEnvironment>, path: string, body: unknown): Promise<Response> =>
    Promise.resolve(
      app.request(`http://test${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
    )

  it('counts Python runs and translations together, as HAWKI does', async () => {
    const app = testApp(translatorApp, undefined, 'throttled-user')
    const first = await post(app, '/execute-python', { code: ' ' })
    expect(first.status).toBe(400)
    expect(first.headers.get('X-RateLimit-Limit')).toBe(String(TRANSLATOR_REQUESTS_PER_MINUTE))
    expect(first.headers.get('X-RateLimit-Remaining')).toBe(
      String(TRANSLATOR_REQUESTS_PER_MINUTE - 1)
    )
    for (let run = 1; run < TRANSLATOR_REQUESTS_PER_MINUTE; run++) {
      expect((await post(app, '/execute-python', { code: ' ' })).status).toBe(400)
    }

    const translation = await post(app, '/translate', { text: ['Hallo'], target: 'en-gb' })
    expect(translation.status).toBe(429)
    expect(translation.headers.get('X-RateLimit-Remaining')).toBe('0')
    expect(Number(translation.headers.get('Retry-After'))).toBeGreaterThan(0)
    await expect(translation.json()).resolves.toEqual({
      error: { code: 'rate_limited', message: TRANSLATOR_THROTTLED_MESSAGE }
    })
    // Another user's minute is their own.
    const other = await post(testApp(translatorApp, undefined, 'other-user'), '/rephrase', {})
    expect(other.status).toBe(400)
  })
})

describe('translator admin routes', () => {
  const listModels = (app: Hono<AppEnvironment>, body: unknown): Promise<Response> =>
    Promise.resolve(
      app.request('http://test/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
    )

  it('lists the models with the saved key unless the form sends one', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ data: [{ id: 'campus-1', name: 'Campus model' }] })
    )
    vi.stubGlobal('fetch', fetchMock)
    const app = testApp(translatorAdminApp, { deeplApiKey: null, llmApiKey: 'saved' })

    const saved = await listModels(app, { baseUrl: 'https://llm.example.test/v1/' })
    expect(saved.status).toBe(200)
    await expect(saved.json()).resolves.toEqual({
      models: [{ id: 'campus-1', label: 'Campus model' }]
    })
    await listModels(app, { baseUrl: 'https://llm.example.test/v1', apiKey: 'typed' })
    await listModels(app, { baseUrl: 'https://llm.example.test/v1', apiKey: null })

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>
    expect(calls.map(([url]) => url)).toEqual([
      'https://llm.example.test/v1/models',
      'https://llm.example.test/v1/models',
      'https://llm.example.test/v1/models'
    ])
    expect(calls.map(([, init]) => new Headers(init.headers).get('Authorization'))).toEqual([
      'Bearer saved',
      'Bearer typed',
      null
    ])
  })

  it('answers module_unavailable when the endpoint refuses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Unauthorized', { status: 401 }))
    )
    const response = await listModels(testApp(translatorAdminApp), {
      baseUrl: 'https://llm.example.test/v1'
    })
    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'module_unavailable' } })
  })
})
