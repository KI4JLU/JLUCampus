#!/usr/bin/env node
/**
 * A local stand-in for every upstream of the transcription module, for development and tests:
 * speech recognition, diarisation, the chat model and the realtime WebSockets of live
 * transcription. It needs no keys and accepts any `Authorization` header. See README.md for the admin settings that point at it.
 *
 *   bun run mock:transcription                       # port 9200
 *   TRANSCRIPTION_MOCK_PORT=9300 bun run mock:transcription
 */
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

import * as asr from './asr.mjs'
import * as diarization from './diarization.mjs'
import { sendJson } from './http.mjs'
import * as llm from './llm.mjs'
import * as realtime from './realtime.mjs'

/** Each module answers the paths below its prefix. */
const modules = [
  { prefix: '/asr', module: asr },
  { prefix: '/diarization', module: diarization },
  { prefix: '/llm', module: llm },
  { prefix: '/realtime', module: realtime }
]

export async function route(request, response) {
  const { pathname } = new URL(request.url ?? '/', 'http://mock')
  if (request.method === 'GET' && pathname === '/health') {
    sendJson(response, 200, { ok: true })
    return
  }
  for (const { prefix, module } of modules) {
    if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
    if (await module.handle(request, response, pathname.slice(prefix.length) || '/')) return
  }
  sendJson(response, 404, { error: { message: `No mock for ${request.method} ${pathname}` } })
}

export function startMock(port) {
  const server = createServer((request, response) => {
    const started = Date.now()
    response.on('finish', () => {
      console.log(
        `${request.method} ${request.url} ${response.statusCode} ${Date.now() - started}ms`
      )
    })
    route(request, response).catch((error) => {
      console.error(error)
      if (!response.headersSent) sendJson(response, 500, { error: { message: String(error) } })
      else response.end()
    })
  })
  // The realtime WebSockets (`realtime.mjs`); any other upgrade is refused.
  server.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url ?? '/', 'http://mock')
    const below = pathname.startsWith('/realtime/') ? pathname.slice('/realtime'.length) : null
    if (below === null || !realtime.upgrade(request, socket, head, below)) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
    }
  })
  // Closing the mock ends its realtime streams too, which would otherwise keep it open.
  const close = server.close.bind(server)
  server.close = (callback) => {
    realtime.closeStreams()
    return close(callback)
  }
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.TRANSCRIPTION_MOCK_PORT ?? 9200)
  await startMock(port)
  console.log(`Transcription mock on http://127.0.0.1:${port}`)
}
