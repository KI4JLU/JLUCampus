import {
  transcriptionRealtimeConfigSchema,
  transcriptionRealtimeIceSchema,
  transcriptionRealtimeSessionSchema,
  transcriptionSignalingRequestSchema,
  transcriptionSignalingResponseSchema
} from '@justcampus/shared'
import { Hono } from 'hono'

import { ApiError, parseBody } from '../../../api.js'
import { env } from '../../../env.js'
import { getModuleRuntime } from '../../context.js'
import type { AppEnvironment } from '../../types.js'
import { defaultRealtimeMode, openaiRealtimeEndpoints, realtimeModes } from '../config.js'
import { upstream } from '../http.js'
import {
  OnpremUnavailable,
  onpremAvailability,
  onpremSignaling,
  onpremTarget,
  rememberAvailability
} from './bridge.js'
import { sessionIceServers, TurnNotSetUpError } from './turn.js'
import { issueClientSecret } from './upstream.js'

/**
 * Live transcription (`TRANSCRIPTION_API.realtime*`): the modes that are set up, the on-prem ICE
 * servers with short-lived TURN credentials, the on-prem SDP proxy and ephemeral OpenAI Realtime
 * keys.
 */
export const realtimeRouter = new Hono<AppEnvironment>()

/**
 * The modes set up (on-prem needs its bridge and gateway, OpenAI its key) and the default (T-59).
 * On-prem is left out while the bridge's probe finds that it cannot run, such as a gateway key
 * that may not use the realtime model; `onpremUnavailable` says why.
 */
realtimeRouter.get('/realtime/config', async (context) => {
  const { config, secrets } = getModuleRuntime(context, 'transcription')
  let modes = realtimeModes(config, secrets)
  const target = onpremTarget(config, secrets, env.TRANSCRIPTION_REALTIME_BRIDGE_KEY)
  const onpremUnavailable =
    modes.includes('onprem') && target ? await onpremAvailability(target) : null
  if (onpremUnavailable) modes = modes.filter((mode) => mode !== 'onprem')
  return context.json(
    transcriptionRealtimeConfigSchema.parse({
      modes,
      defaultMode: defaultRealtimeMode(config, modes),
      // Addresses only; credentials come with `/realtime/onprem/ice-servers` for each session.
      iceServers: modes.includes('onprem') ? config.realtimeIceServers : [],
      openaiModel: modes.includes('openai') ? config.openaiRealtimeModel : null,
      onpremUnavailable
    })
  )
})

/**
 * The on-prem ICE servers for one session, TURN ones with credentials that expire (T-60). Asked for
 * right before the peer connection is made, and never cached.
 */
realtimeRouter.post('/realtime/onprem/ice-servers', (context) => {
  const { config, secrets } = getModuleRuntime(context, 'transcription')
  if (!realtimeModes(config, secrets).includes('onprem')) {
    throw new ApiError(502, 'module_unavailable', 'On-prem live transcription is not set up')
  }
  let ice
  try {
    ice = sessionIceServers(config, env.TRANSCRIPTION_TURN_SECRET)
  } catch (error) {
    if (!(error instanceof TurnNotSetUpError)) throw error
    console.error(error.message)
    throw new ApiError(502, 'module_unavailable', 'The TURN server credentials are not set up')
  }
  context.header('Cache-Control', 'no-store')
  return context.json(transcriptionRealtimeIceSchema.parse(ice))
})

/**
 * Passes the browser's SDP offer to the on-prem bridge with the gateway's base, key and model, and
 * its answer back (T-60). The key stays between this server and the bridge.
 */
realtimeRouter.post('/realtime/onprem/signaling', async (context) => {
  const { sdp } = await parseBody(context, transcriptionSignalingRequestSchema)
  const { config, secrets } = getModuleRuntime(context, 'transcription')
  const target = onpremTarget(config, secrets, env.TRANSCRIPTION_REALTIME_BRIDGE_KEY)
  if (!realtimeModes(config, secrets).includes('onprem') || !target) {
    throw new ApiError(502, 'module_unavailable', 'On-prem live transcription is not set up')
  }
  const answer = await upstream('The signaling bridge did not answer', async () => {
    try {
      return await onpremSignaling(target, sdp, context.req.raw.signal)
    } catch (error) {
      if (!(error instanceof OnpremUnavailable)) throw error
      // The live tab's config shows it from now on, until the next probe.
      rememberAvailability(target, { reason: error.reason, model: error.model })
      console.error(`Transcription realtime signaling failed: ${error.message}`, error.detail ?? '')
      throw new ApiError(502, 'module_unavailable', error.message)
    }
  })
  rememberAvailability(target, null)
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
