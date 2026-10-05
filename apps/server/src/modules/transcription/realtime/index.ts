import { upgradeWebSocket } from '@hono/node-server'
import {
  transcriptionRealtimeConfigSchema,
  transcriptionRealtimeModeSchema,
  type TranscriptionRealtimeMode
} from '@justcampus/shared'
import { Hono, type Context } from 'hono'
import type WebSocket from 'ws'

import { env } from '../../../env.js'
import { isTrustedWebSocketOrigin, trustedOrigins } from '../../../origin.js'
import { getModuleRuntime } from '../../context.js'
import type { AppEnvironment } from '../../types.js'
import { defaultRealtimeMode, realtimeModes } from '../config.js'
import { realtimeAvailability, realtimeTarget } from './gateway.js'
import { clientEvents } from './protocol.js'
import { CLOSE, LiveSession, SessionSlots, type ClientSocket } from './relay.js'

/**
 * Live transcription (`TRANSCRIPTION_API.realtime*`): the modes that are set up, and the live
 * WebSocket, which relays the browser's audio to the gateway's realtime WebSocket with the key
 * this server holds (`relay.ts`). Browsers reach nothing but the API's own origin.
 */
export const realtimeRouter = new Hono<AppEnvironment>()

/** Live sessions at once on this server, and per person. */
export const liveSlots = new SessionSlots(
  env.TRANSCRIPTION_LIVE_MAX_SESSIONS,
  env.TRANSCRIPTION_LIVE_MAX_SESSIONS_PER_USER
)

const origins = trustedOrigins(env.CORS_ORIGINS, env.BETTER_AUTH_URL)

/**
 * The modes set up (on-prem needs its gateway, OpenAI its key) and the default (T-59). On-prem is
 * left out while the server's probe finds that the gateway refuses, such as a key that may not use
 * the realtime model; `onpremUnavailable` says why.
 */
realtimeRouter.get('/realtime/config', async (context) => {
  const { config, secrets } = getModuleRuntime(context, 'transcription')
  let modes = realtimeModes(config, secrets)
  const target = modes.includes('onprem') ? realtimeTarget('onprem', config, secrets) : null
  const onpremUnavailable = target ? await realtimeAvailability(target) : null
  if (onpremUnavailable) modes = modes.filter((mode) => mode !== 'onprem')
  return context.json(
    transcriptionRealtimeConfigSchema.parse({
      modes,
      defaultMode: defaultRealtimeMode(config, modes),
      onpremUnavailable
    })
  )
})

/**
 * The upgrade itself is refused, with an HTTP status, only for what a page must not do at all: no
 * session (the app's middleware answers 401 before this), an origin that is not trusted, no
 * WebSocket or no known mode. Everything the live tab shows (not set up, busy, a refusing
 * gateway) comes as an `error` event on the open socket, since a browser cannot read the status
 * of a refused upgrade.
 */
function liveGuard(context: Context<AppEnvironment>): Response | null {
  if (!context.get('session')) {
    return context.json(
      { error: { code: 'unauthorized', message: 'Authentication required' } },
      401
    )
  }
  if (!isTrustedWebSocketOrigin(context.req.header('Origin'), origins)) {
    return context.json({ error: { code: 'forbidden', message: 'Untrusted origin' } }, 403)
  }
  if (context.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    return context.json({ error: { code: 'upgrade_required', message: 'WebSocket only' } }, 426)
  }
  if (!transcriptionRealtimeModeSchema.safeParse(context.req.query('mode')).success) {
    return context.json({ error: { code: 'validation', message: 'Unknown live mode' } }, 400)
  }
  return null
}

/** The `ws` socket behind Hono's WebSocket context, as the session uses it. */
function clientSocket(raw: WebSocket): ClientSocket {
  return {
    send: (data) => raw.send(data),
    close: (code, reason) => raw.close(code, reason),
    terminate: () => raw.terminate(),
    get bufferedAmount() {
      return raw.bufferedAmount
    }
  }
}

realtimeRouter.get(
  '/live',
  async (context, next) => liveGuard(context) ?? (await next()),
  upgradeWebSocket((context) => {
    const typed = context as Context<AppEnvironment>
    const mode = context.req.query('mode') as TranscriptionRealtimeMode
    const { config, secrets } = getModuleRuntime(typed, 'transcription')
    const userId = typed.get('session').user.id
    const target = realtimeModes(config, secrets).includes(mode)
      ? realtimeTarget(mode, config, secrets)
      : null
    let session: LiveSession | null = null
    return {
      onOpen: (_event, socket) => {
        const client = clientSocket(socket.raw as WebSocket)
        if (!target) {
          client.send(JSON.stringify(clientEvents.error('not_set_up')))
          client.close(CLOSE.policy, 'not_set_up')
          return
        }
        // The slot is taken before the gateway is asked; the session frees it on every way out, once
        // its sockets are gone.
        const release = liveSlots.reserve(userId)
        if (!release) {
          client.send(JSON.stringify(clientEvents.error('busy')))
          client.close(CLOSE.tryAgain, 'busy')
          return
        }
        session = new LiveSession({ target, client, onEnd: release })
        void session.start()
      },
      onMessage: (event) => session?.receive(event.data as string | ArrayBuffer),
      onClose: (event) => session?.clientClosed(event.code),
      onError: () => session?.clientFailed()
    }
  })
)
