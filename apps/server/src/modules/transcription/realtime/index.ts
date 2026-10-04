import {
  transcriptionRealtimeConfigSchema,
  transcriptionRealtimeSessionSchema,
  transcriptionSignalingRequestSchema,
  transcriptionSignalingResponseSchema
} from '@justcampus/shared'
import { Hono } from 'hono'

import { ApiError, parseBody } from '../../../api.js'
import { getModuleRuntime } from '../../context.js'
import type { AppEnvironment } from '../../types.js'
import { defaultRealtimeMode, openaiRealtimeEndpoints, realtimeModes } from '../config.js'
import { upstream } from '../http.js'
import { issueClientSecret, onpremSignaling } from './upstream.js'

/**
 * Live transcription (`TRANSCRIPTION_API.realtime*`): the modes that are set up, the on-prem SDP
 * proxy and ephemeral OpenAI Realtime keys.
 */
export const realtimeRouter = new Hono<AppEnvironment>()

/** The modes set up (on-prem needs its bridge, OpenAI its key) and the default (T-59). */
realtimeRouter.get('/realtime/config', (context) => {
  const { config, secrets } = getModuleRuntime(context, 'transcription')
  const modes = realtimeModes(config, secrets)
  return context.json(
    transcriptionRealtimeConfigSchema.parse({
      modes,
      defaultMode: defaultRealtimeMode(config, modes),
      iceServers: modes.includes('onprem') ? config.realtimeIceServers : [],
      openaiModel: modes.includes('openai') ? config.openaiRealtimeModel : null
    })
  )
})

/** Passes the browser's SDP offer to the on-prem bridge and its answer back (T-60). */
realtimeRouter.post('/realtime/onprem/signaling', async (context) => {
  const { sdp } = await parseBody(context, transcriptionSignalingRequestSchema)
  const { config, secrets } = getModuleRuntime(context, 'transcription')
  if (!realtimeModes(config, secrets).includes('onprem') || !config.onpremSignalingUrl) {
    throw new ApiError(502, 'module_unavailable', 'On-prem live transcription is not set up')
  }
  const url = config.onpremSignalingUrl
  const answer = await upstream('The signaling bridge did not answer', () =>
    onpremSignaling(url, sdp, context.req.raw.signal)
  )
  return context.json(transcriptionSignalingResponseSchema.parse({ sdp: answer }))
})

/**
 * An ephemeral OpenAI key for one live session; the browser sends its SDP offer with it to
 * `callsUrl`. The admin's key never leaves the server.
 */
realtimeRouter.post('/realtime/session', async (context) => {
  const { config, secrets } = getModuleRuntime(context, 'transcription')
  const apiKey = secrets.openaiRealtimeApiKey
  if (!realtimeModes(config, secrets).includes('openai') || !apiKey) {
    throw new ApiError(502, 'module_unavailable', 'OpenAI live transcription is not set up')
  }
  const { clientSecretsUrl, callsUrl } = openaiRealtimeEndpoints(config)
  const model = config.openaiRealtimeModel
  const secret = await upstream('OpenAI Realtime did not issue a key', () =>
    issueClientSecret(clientSecretsUrl, apiKey, model, context.req.raw.signal)
  )
  context.header('Cache-Control', 'no-store')
  return context.json(
    transcriptionRealtimeSessionSchema.parse({
      value: secret.value,
      expiresAt: secret.expiresAt,
      callsUrl,
      model
    })
  )
})
