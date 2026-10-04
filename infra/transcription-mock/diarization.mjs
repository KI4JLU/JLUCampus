import { notImplemented } from './http.mjs'

/**
 * Speaker diarisation, below `/diarization`: `POST /diarize` takes audio (multipart `file`) and
 * answers the speaker turns. The format is the one the server's diarisation adapter expects.
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {string} path the path below `/diarization`, e.g. `/diarize`
 * @returns {Promise<boolean>} whether the request was handled
 */
export async function handle(request, response, path) {
  if (request.method === 'POST' && path === '/diarize') {
    notImplemented(response, 'Diarisation')
    return true
  }
  return false
}
