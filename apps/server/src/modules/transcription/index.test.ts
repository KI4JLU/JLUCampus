import { TRANSCRIPTION_API, TRANSCRIPTION_DEFAULT_CONFIG } from '@justcampus/shared'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'

import { ApiError } from '../../api.js'
import type { AppEnvironment } from '../types.js'
import { transcriptionAdminApp, transcriptionApp } from './index.js'
import { notImplemented } from './stub.js'

function testApp(routes: Hono<AppEnvironment>): Hono<AppEnvironment> {
  const app = new Hono<AppEnvironment>()
  app.use('*', async (context, next) => {
    context.set('session', { user: { id: 'user' } } as AppEnvironment['Variables']['session'])
    context.set('module', {
      type: 'transcription',
      componentId: 'component',
      config: TRANSCRIPTION_DEFAULT_CONFIG,
      secrets: {
        apiKey: null,
        diarizationApiKey: null,
        llmApiKey: null,
        openaiRealtimeApiKey: null
      }
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

const MODULE = '/api/modules/transcription'
const ADMIN = '/api/admin/modules/transcription'
const id = '11111111-1111-4111-8111-111111111111'

/** Every route of the contract, as method and path relative to its app. */
const contractRoutes: Array<[method: string, path: string]> = [
  ['GET', TRANSCRIPTION_API.capabilities],
  ['GET', TRANSCRIPTION_API.jobs],
  ['POST', TRANSCRIPTION_API.jobs],
  ['GET', TRANSCRIPTION_API.job(id)],
  ['DELETE', TRANSCRIPTION_API.job(id)],
  ['POST', TRANSCRIPTION_API.jobAnalyze(id)],
  ['POST', TRANSCRIPTION_API.jobDispatch(id)],
  ['GET', TRANSCRIPTION_API.jobAudio(id)],
  ['GET', TRANSCRIPTION_API.jobSample(id, 'SPEAKER_00-1')],
  ['GET', TRANSCRIPTION_API.transcripts],
  ['POST', TRANSCRIPTION_API.transcripts],
  ['GET', TRANSCRIPTION_API.transcript(id)],
  ['PATCH', TRANSCRIPTION_API.transcript(id)],
  ['DELETE', TRANSCRIPTION_API.transcript(id)],
  ['POST', TRANSCRIPTION_API.transcriptSubtitle(id)],
  ['GET', TRANSCRIPTION_API.formats],
  ['POST', TRANSCRIPTION_API.formats],
  ['DELETE', TRANSCRIPTION_API.format(id)],
  ['GET', TRANSCRIPTION_API.templates],
  ['POST', TRANSCRIPTION_API.templates],
  ['DELETE', TRANSCRIPTION_API.template('interview')],
  ['POST', TRANSCRIPTION_API.summaries],
  ['POST', TRANSCRIPTION_API.summaryPreview],
  ['POST', TRANSCRIPTION_API.speakerOptimization],
  ['GET', TRANSCRIPTION_API.realtimeConfig],
  ['POST', TRANSCRIPTION_API.realtimeOnpremSignaling],
  ['POST', TRANSCRIPTION_API.realtimeSession],
  ['POST', TRANSCRIPTION_API.adminModels],
  ['POST', TRANSCRIPTION_API.adminTest]
]

/** Whether a route of `app` matches the method and path, `:param` segments matching any one segment. */
function declared(app: Hono<AppEnvironment>, method: string, path: string): boolean {
  return app.routes.some((route) => {
    if (route.method !== method) return false
    const pattern = new RegExp(`^${route.path.replace(/:[^/]+/g, '[^/]+')}$`)
    return pattern.test(path)
  })
}

describe('transcription routes', () => {
  it('declares every route of the contract', () => {
    for (const [method, path] of contractRoutes) {
      const admin = path.startsWith(ADMIN)
      const app = admin ? transcriptionAdminApp : transcriptionApp
      const relative = path.slice((admin ? ADMIN : MODULE).length)
      expect(declared(app, method, relative), `${method} ${path}`).toBe(true)
    }
  })

  it('reports what a fresh module offers', async () => {
    const response = await testApp(transcriptionApp).request('http://test/capabilities')
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ batch: false, realtimeModes: [] })
  })

  it('answers 501 not_implemented from a stub handler', async () => {
    const stub = new Hono<AppEnvironment>()
    stub.get('/later', notImplemented)
    const response = await testApp(stub).request('http://test/later')
    expect(response.status).toBe(501)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'not_implemented' } })
  })
})
