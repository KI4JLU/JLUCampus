import { Hono } from 'hono'

import type { AppEnvironment } from '../../types.js'
import { notImplemented } from '../stub.js'

/**
 * Live transcription (`TRANSCRIPTION_API.realtime*`): the modes that are set up, the on-prem SDP
 * proxy and ephemeral OpenAI Realtime keys.
 */
export const realtimeRouter = new Hono<AppEnvironment>()

realtimeRouter.get('/realtime/config', notImplemented)
realtimeRouter.post('/realtime/onprem/signaling', notImplemented)
realtimeRouter.post('/realtime/session', notImplemented)
