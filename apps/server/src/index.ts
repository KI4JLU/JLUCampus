import { serve } from '@hono/node-server'

import { app } from './app.js'
import { env } from './env.js'
import { ensureSingletonComponents, startModules } from './modules/index.js'
import { createWebSocketServer } from './websocket.js'

await ensureSingletonComponents()
startModules()
serve(
  { fetch: app.fetch, port: env.PORT, websocket: { server: createWebSocketServer() } },
  ({ port }) => {
    console.log(`JLU Campus API listening at http://localhost:${port}`)
  }
)
