import { notImplemented, sendJson } from './http.mjs'

/**
 * OpenAI-compatible speech recognition, below `/asr/v1`: `GET /models` and
 * `POST /audio/transcriptions` (multipart `file`, `model`, optional `language`,
 * `response_format=verbose_json`) answering Whisper-style `verbose_json` with segments.
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {string} path the path below `/asr`, e.g. `/v1/models`
 * @returns {Promise<boolean>} whether the request was handled
 */
export async function handle(request, response, path) {
  if (request.method === 'GET' && path === '/v1/models') {
    sendJson(response, 200, { object: 'list', data: [{ id: 'jlu/whisper-1', object: 'model' }] })
    return true
  }
  if (request.method === 'POST' && path === '/v1/audio/transcriptions') {
    notImplemented(response, 'Speech recognition')
    return true
  }
  return false
}
