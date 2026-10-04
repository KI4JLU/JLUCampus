import { notImplemented } from './http.mjs'

/**
 * Live transcription, below `/realtime`: the on-prem bridge's `POST /onprem/signaling` (SDP offer
 * in, SDP answer out) and OpenAI Realtime below `/openai/v1`: `POST /realtime/client_secrets`
 * (ephemeral key) and `POST /realtime/calls` (SDP with that key).
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {string} path the path below `/realtime`, e.g. `/onprem/signaling`
 * @returns {Promise<boolean>} whether the request was handled
 */
export async function handle(request, response, path) {
  if (request.method !== 'POST') return false
  if (path === '/onprem/signaling') {
    notImplemented(response, 'On-prem signaling')
    return true
  }
  if (path === '/openai/v1/realtime/client_secrets') {
    notImplemented(response, 'OpenAI client secrets')
    return true
  }
  if (path === '/openai/v1/realtime/calls') {
    notImplemented(response, 'OpenAI realtime calls')
    return true
  }
  return false
}
