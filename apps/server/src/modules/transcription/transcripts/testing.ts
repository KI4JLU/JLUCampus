import { TRANSCRIPTION_DEFAULT_CONFIG, type TranscriptionComponentConfig } from '@justcampus/shared'
import { Hono } from 'hono'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { ApiError } from '../../../api.js'
import type { AppEnvironment } from '../../types.js'
import type { TranscriptionSecrets } from '../config.js'

/**
 * Helpers for the route tests of the transcription module's content areas; not used at runtime.
 */

export const COMPONENT_ID = '00000000-0000-4000-8000-000000000001'

export const NO_SECRETS: TranscriptionSecrets = {
  apiKey: null,
  diarizationApiKey: null,
  llmApiKey: null,
  openaiRealtimeApiKey: null
}

/** `routes` behind a session of `userId` and the module's runtime, answering errors as the app does. */
export function testApp(
  routes: Hono<AppEnvironment>,
  options: {
    userId?: string
    config?: Partial<TranscriptionComponentConfig>
    secrets?: Partial<TranscriptionSecrets>
    language?: string | null
  } = {}
): Hono<AppEnvironment> {
  const app = new Hono<AppEnvironment>()
  app.use('*', async (context, next) => {
    context.set('session', {
      user: { id: options.userId ?? 'alice', language: options.language ?? 'de' }
    } as unknown as AppEnvironment['Variables']['session'])
    context.set('module', {
      type: 'transcription',
      componentId: COMPONENT_ID,
      config: { ...TRANSCRIPTION_DEFAULT_CONFIG, ...options.config },
      secrets: { ...NO_SECRETS, ...options.secrets }
    })
    await next()
  })
  app.onError((error, context) => {
    if (error instanceof ApiError) {
      return context.json(
        {
          error: {
            code: error.code,
            message: error.message,
            ...(error.issues ? { issues: error.issues } : {})
          }
        },
        error.status
      )
    }
    throw error
  })
  app.route('/', routes)
  return app
}

/** A JSON request for `app.request`. */
export function json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

export interface RunningMock {
  /** `http://127.0.0.1:<port>` */
  origin: string
  close: () => Promise<void>
}

/** Starts `infra/transcription-mock` on a free port. */
export async function startUpstreamMock(): Promise<RunningMock> {
  const path = new URL('../../../../../../infra/transcription-mock/server.mjs', import.meta.url)
  const { startMock } = (await import(path.href)) as {
    startMock: (port: number) => Promise<Server>
  }
  const server = await startMock(0)
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  }
}

/** Settings that point the chat endpoint at the mock. */
export function mockChatConfig(origin: string): Partial<TranscriptionComponentConfig> {
  return {
    llmBaseUrl: `${origin}/llm/v1`,
    llmModels: [
      { id: 'mock-chat', label: 'Mock Chat' },
      { id: 'mock-prose', label: 'Mock Prose' },
      { id: 'mock-fail', label: 'Mock Fail' }
    ],
    defaultSummaryModel: 'mock-chat',
    defaultCorrectionModel: 'mock-chat'
  }
}
