import { serve } from '@hono/node-server'

import { app } from './app.js'
import { env } from './env.js'
import { ensureSingletonComponents, startModules } from './modules/index.js'
import { createWebSocketServer } from './websocket.js'

await ensureSingletonComponents()
startModules()
serve(
  {
    fetch: app.fetch,
    port: env.PORT,
    websocket: { server: createWebSocketServer() },
    // Transcription uploads stream through the API (up to 500 MB); Node's default ends any request
    // after five minutes, too short on a slow line.
    serverOptions: { requestTimeout: 60 * 60 * 1000 }
  },
  ({ port }) => {
    console.log(`JLU Campus API listening at http://localhost:${port}`)
  }
)
