import { TRANSCRIPTION_LIVE_MESSAGE_MAX_BYTES } from '@justcampus/shared'
import { WebSocketServer } from 'ws'

/**
 * The server's WebSocket upgrades (`upgradeWebSocket` of `@hono/node-server`), which run through
 * the app's middleware like any request. The only WebSocket route is live transcription, whose
 * largest message bounds every message: `ws` closes a socket that sends more (1009).
 */
export function createWebSocketServer(): WebSocketServer {
  return new WebSocketServer({
    noServer: true,
    maxPayload: TRANSCRIPTION_LIVE_MESSAGE_MAX_BYTES,
    perMessageDeflate: false
  })
}
