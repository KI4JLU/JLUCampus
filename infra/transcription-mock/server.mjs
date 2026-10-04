#!/usr/bin/env node
/**
 * A local stand-in for every upstream of the transcription module, for development and tests:
 * speech recognition, diarisation, the chat model and live transcription. It needs no keys and
 * accepts any `Authorization` header. See README.md for the admin settings that point at it.
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
  // Browsers call OpenAI Realtime's `/calls` themselves, as they would api.openai.com, which
  // allows any origin.
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Expose-Headers', 'Location')
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '600'
    })
    response.end()
    return
  }
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
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.TRANSCRIPTION_MOCK_PORT ?? 9200)
  await startMock(port)
  console.log(`Transcription mock on http://127.0.0.1:${port}`)
}
