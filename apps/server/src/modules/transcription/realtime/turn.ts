import { createHmac } from 'node:crypto'

import type {
  TranscriptionComponentConfig,
  TranscriptionRealtimeIce,
  TranscriptionSessionIceServer
} from '@justcampus/shared'

/**
 * The on-prem path's ICE servers for one live session (T-60). With `realtimeTurnAuth: 'ephemeral'`
 * the TURN servers get credentials of the TURN REST API (coturn's `use-auth-secret`): the user
 * name is the expiry in Unix seconds, the credential its HMAC-SHA1 with the shared secret, in
 * Base64. The secret stays on the server; what the browser gets stops working at the expiry.
 */

/** Whether an ICE server has a TURN address, which credentials are for. */
export function isTurnServer(urls: readonly string[]): boolean {
  return urls.some((url) => /^turns?:/i.test(url.trim()))
}

/** A TURN REST API credential pair valid until `expiresAt`. */
export function turnCredential(
  secret: string,
  expiresAt: Date
): { username: string; credential: string } {
  const username = `${Math.floor(expiresAt.getTime() / 1000)}:jlu-campus`
  const credential = createHmac('sha1', secret).update(username).digest('base64')
  return { username, credential }
}

/** Thrown while TURN wants credentials but the server has no shared secret. */
export class TurnNotSetUpError extends Error {
  constructor() {
    super('TURN credentials are configured, but TRANSCRIPTION_TURN_SECRET is not set')
    this.name = 'TurnNotSetUpError'
  }
}

/** The configured ICE servers, TURN ones with fresh credentials where the config asks for them. */
export function sessionIceServers(
  config: Pick<
    TranscriptionComponentConfig,
    'realtimeIceServers' | 'realtimeTurnAuth' | 'realtimeTurnCredentialSeconds'
  >,
  secret: string | undefined,
  now: Date = new Date()
): TranscriptionRealtimeIce {
  const servers = config.realtimeIceServers
  const needsCredentials =
    config.realtimeTurnAuth === 'ephemeral' && servers.some((server) => isTurnServer(server.urls))
  if (!needsCredentials) {
    return { iceServers: servers.map((server) => ({ urls: [...server.urls] })), expiresAt: null }
  }
  if (!secret) throw new TurnNotSetUpError()
  const expiresAt = new Date(now.getTime() + config.realtimeTurnCredentialSeconds * 1000)
  const pair = turnCredential(secret, expiresAt)
  return {
    iceServers: servers.map((server): TranscriptionSessionIceServer =>
      isTurnServer(server.urls) ? { urls: [...server.urls], ...pair } : { urls: [...server.urls] }
    ),
    expiresAt: expiresAt.toISOString()
  }
}
