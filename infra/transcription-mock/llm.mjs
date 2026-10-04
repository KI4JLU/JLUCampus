import { notImplemented, sendJson } from './http.mjs'

/**
 * OpenAI-compatible chat completions, below `/llm/v1`: `GET /models` and `POST /chat/completions`
 * for text correction, subtitles, speaker optimisation, summaries and section previews.
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {string} path the path below `/llm`, e.g. `/v1/chat/completions`
 * @returns {Promise<boolean>} whether the request was handled
 */
export async function handle(request, response, path) {
  if (request.method === 'GET' && path === '/v1/models') {
    sendJson(response, 200, { object: 'list', data: [{ id: 'mock-chat', object: 'model' }] })
    return true
  }
  if (request.method === 'POST' && path === '/v1/chat/completions') {
    notImplemented(response, 'Chat completions')
    return true
  }
  return false
}
