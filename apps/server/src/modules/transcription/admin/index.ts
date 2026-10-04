import {
  transcriptionConnectionTestRequestSchema,
  transcriptionConnectionTestSchema,
  transcriptionModelListSchema,
  transcriptionModelsRequestSchema
} from '@justcampus/shared'
import { Hono } from 'hono'

import { ApiError, parseBody } from '../../../api.js'
import { getModuleRuntime } from '../../context.js'
import type { AppEnvironment } from '../../types.js'
import { transcriptionStorage } from '../storage.js'
import { discoverModels, safeMessage, testConnection } from './connections.js'

/**
 * The admin form's helpers (`TRANSCRIPTION_API.adminModels`, `TRANSCRIPTION_API.adminTest`): model
 * discovery and connection tests. They also work while the module is disabled.
 */
export const adminRouter = new Hono<AppEnvironment>()

/**
 * The models of the speech or chat endpoint, in its order, with the key typed in the form or the
 * saved one of that endpoint. Speech lists are taken whole; chat lists lose embedding, speech and
 * image models, as in the translator.
 */
adminRouter.post('/models', async (context) => {
  const input = await parseBody(context, transcriptionModelsRequestSchema)
  const { secrets } = getModuleRuntime(context, 'transcription')
  const saved = input.kind === 'asr' ? secrets.apiKey : secrets.llmApiKey
  const apiKey = input.apiKey === undefined ? saved : input.apiKey
  try {
    const models = await discoverModels(input.kind, input.baseUrl, apiKey, context.req.raw.signal)
    return context.json(transcriptionModelListSchema.parse({ models }))
  } catch (error) {
    console.error(
      'Transcription model discovery failed',
      safeMessage(String(error), [apiKey, ...Object.values(secrets)])
    )
    throw new ApiError(502, 'module_unavailable', 'The endpoint did not list its models')
  }
})

/** Checks one upstream; the answer says whether it worked and why not, never with a key. */
adminRouter.post('/test', async (context) => {
  const input = await parseBody(context, transcriptionConnectionTestRequestSchema)
  const runtime = getModuleRuntime(context, 'transcription')
  const result = await testConnection(input, {
    runtime,
    storage: transcriptionStorage(),
    signal: context.req.raw.signal
  })
  return context.json(transcriptionConnectionTestSchema.parse(result))
})
