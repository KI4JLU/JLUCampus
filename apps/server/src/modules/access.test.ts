import { FEATURE_KEYS } from '@justcampus/shared'
import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'

import { ApiError } from '../api.js'
import { registerModuleRoutes } from './index.js'
import { loadModuleRuntime } from './runtime.js'
import type { AppEnvironment } from './types.js'

vi.mock('./runtime.js', () => ({ loadModuleRuntime: vi.fn() }))

function testApp(
  options: {
    components?: string[]
    features?: readonly (typeof FEATURE_KEYS)[number][]
    signedOut?: boolean
  } = {}
): Hono<AppEnvironment> {
  const app = new Hono<AppEnvironment>()
  app.use('*', async (context, next) => {
    if (!options.signedOut)
      context.set('session', { user: { id: 'alice' } } as AppEnvironment['Variables']['session'])
    context.set(
      'access',
      Promise.resolve({
        isAdmin: false,
        componentIds: new Set(options.components ?? ['module']),
        features: new Set(options.features ?? FEATURE_KEYS)
      })
    )
    await next()
  })
  app.onError((error, context) => {
    if (error instanceof ApiError)
      return context.json({ error: { code: error.code, message: error.message } }, error.status)
    throw error
  })
  registerModuleRoutes(app)
  return app
}

function runtime(type: 'translator' | 'transcription'): void {
  vi.mocked(loadModuleRuntime).mockResolvedValue({
    type,
    componentId: 'module',
    config: { documentsEnabled: true },
    secrets: { deeplApiKey: 'key' }
  } as Awaited<ReturnType<typeof loadModuleRuntime>>)
}

describe('module permission enforcement', () => {
  it('refuses an enabled module without component permission', async () => {
    runtime('translator')
    const response = await testApp({ components: [] }).request('/api/modules/translator/engines')
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      error: { code: 'forbidden', message: 'Component permission required' }
    })
  })

  it('keeps disabled or missing modules unavailable', async () => {
    vi.mocked(loadModuleRuntime).mockResolvedValue(null)
    expect((await testApp().request('/api/modules/translator/engines')).status).toBe(404)
  })

  it.each([
    ['GET', '/documents'],
    ['POST', '/documents'],
    ['GET', '/documents/any/download'],
    ['DELETE', '/documents/any'],
    ['POST', '/rephrase'],
    ['POST', '/compose'],
    ['POST', '/execute-python'],
    ['GET', '/glossaries'],
    ['POST', '/glossaries/import'],
    ['PATCH', '/glossaries/any']
  ])('refuses translator %s %s before its handler', async (method, path) => {
    runtime('translator')
    const response = await testApp({ features: [] }).request(`/api/modules/translator${path}`, {
      method
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      error: { code: 'forbidden', message: 'Function permission required' }
    })
  })

  it('hides document support in the engines answer without the feature', async () => {
    runtime('translator')
    const response = await testApp({ features: [] }).request('/api/modules/translator/engines')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ documents: false })
    const allowed = await testApp().request('/api/modules/translator/engines')
    expect(await allowed.json()).toMatchObject({ documents: true })
  })

  it.each([
    ['POST', '/summaries'],
    ['POST', '/summaries/preview'],
    ['GET', '/templates'],
    ['DELETE', '/templates/any'],
    ['GET', '/realtime/config']
  ])('refuses transcription %s %s before its handler', async (method, path) => {
    runtime('transcription')
    expect(
      (await testApp({ features: [] }).request(`/api/modules/transcription${path}`, { method }))
        .status
    ).toBe(403)
  })

  it('refuses the live upgrade without a feature while retaining the session guard', async () => {
    runtime('transcription')
    const headers = { Origin: 'http://localhost:5173', Upgrade: 'websocket' }
    const denied = await testApp({ features: [] }).request(
      '/api/modules/transcription/live?mode=onprem',
      { headers }
    )
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({
      error: { code: 'forbidden', message: 'Function permission required' }
    })
    const signedOut = await testApp({ signedOut: true, features: [] }).request(
      '/api/modules/transcription/live?mode=onprem',
      { headers }
    )
    expect(signedOut.status).toBe(401)
  })
})
