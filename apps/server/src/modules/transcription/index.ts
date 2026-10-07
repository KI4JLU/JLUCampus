import { Hono } from 'hono'

import { getModuleRuntime } from '../context.js'
import type { AppEnvironment, ServerModule } from '../types.js'
import { adminRouter } from './admin/index.js'
import { capabilitiesOf, transcriptionConfigSchema, transcriptionDefaultConfig } from './config.js'
import { eventsRouter } from './events/index.js'
import { transcriptionEventsHub } from './events/hub.js'
import { formatsRouter } from './formats/index.js'
import { jobsRouter } from './jobs/index.js'
import { startJobWorker } from './jobs/worker.js'
import { optimizeRouter } from './optimize/index.js'
import { realtimeRouter } from './realtime/index.js'
import { transcriptionStorage } from './storage.js'
import { summariesRouter } from './summaries/index.js'
import { templatesRouter } from './templates/index.js'
import { transcriptsRouter } from './transcripts/index.js'
import { startTranscriptRetention } from './transcripts/retention.js'

/**
 * The transcription module (see `docs/TRANSCRIPTION-REQUIREMENTS.md`). Each area has its own
 * router; this file only puts them together and reports the capabilities.
 */
export const transcriptionApp = new Hono<AppEnvironment>()

transcriptionApp.get('/capabilities', (context) => {
  const { config, secrets } = getModuleRuntime(context, 'transcription')
  return context.json(capabilitiesOf(config, secrets, transcriptionStorage() !== null))
})

transcriptionApp.route('/', eventsRouter)
transcriptionApp.route('/', jobsRouter)
transcriptionApp.route('/', transcriptsRouter)
transcriptionApp.route('/', formatsRouter)
transcriptionApp.route('/', templatesRouter)
transcriptionApp.route('/', summariesRouter)
transcriptionApp.route('/', optimizeRouter)
transcriptionApp.route('/', realtimeRouter)

export const transcriptionAdminApp = new Hono<AppEnvironment>()

transcriptionAdminApp.route('/', adminRouter)

/** Starts the event listener, job worker and transcript retention sweep. */
function startTranscription(): () => void {
  void transcriptionEventsHub.start().catch((error: unknown) => {
    console.error('Transcription event listener could not be started', error)
  })
  const stops = [() => transcriptionEventsHub.stop(), startJobWorker(), startTranscriptRetention()]
  return () => {
    for (const stop of stops) stop()
  }
}

export const transcriptionModule: ServerModule<'transcription'> = {
  type: 'transcription',
  defaultName: 'Transkription',
  defaultIcon: 'mic',
  defaultConfig: transcriptionDefaultConfig,
  configSchema: transcriptionConfigSchema,
  app: transcriptionApp,
  adminApp: transcriptionAdminApp,
  start: startTranscription
}
