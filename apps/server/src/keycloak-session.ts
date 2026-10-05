/**
 * Ties each app session to the Keycloak session it was signed in with.
 *
 * Embedded sites that sign in through the same Keycloak do so silently only while that Keycloak
 * session lives, and Keycloak's login page refuses to be framed. Keycloak ends an idle session
 * after 30 minutes by default, the app session lasts a week. So while the app is in use the server
 * refreshes the session's Keycloak token every few minutes, which counts as activity in Keycloak,
 * and once Keycloak has ended the session (idle or maximum lifetime, signed out elsewhere, user
 * disabled) the app session ends too: one new sign-in then serves the app and every embedded site.
 */

/** Well below Keycloak's default idle timeout of 30 minutes. */
export const KEYCLOAK_CHECK_INTERVAL_MS = 5 * 60_000

export type KeycloakRefresh =
  | { status: 'active'; refreshToken: string }
  /** Keycloak no longer knows the session. */
  | { status: 'ended' }
  /** Keycloak could not answer; the app session is kept. */
  | { status: 'unavailable' }

export interface KeycloakSessionRecord {
  refreshToken: string | null
  checkedAt: Date | null
}

export interface KeycloakSessionStore {
  /** `null` when the app session no longer exists. */
  read(sessionId: string): Promise<KeycloakSessionRecord | null>
  save(sessionId: string, refreshToken: string, checkedAt: Date): Promise<void>
  /** Sets only the check time, keeping whatever token is stored by then. */
  postpone(sessionId: string, checkedAt: Date): Promise<void>
  end(sessionId: string): Promise<void>
}

export interface KeycloakSessionKeeper {
  /** Whether the app session may go on; ends it when its Keycloak session has ended. */
  check(sessionId: string): Promise<boolean>
}

export function createKeycloakSessionKeeper(options: {
  store: KeycloakSessionStore
  refresh: (refreshToken: string) => Promise<KeycloakRefresh>
  now?: () => Date
  intervalMs?: number
}): KeycloakSessionKeeper {
  const {
    store,
    refresh,
    now = () => new Date(),
    intervalMs = KEYCLOAK_CHECK_INTERVAL_MS
  } = options
  // Parallel requests of one session share a check, so a refresh token is spent only once.
  const running = new Map<string, Promise<boolean>>()

  async function run(sessionId: string): Promise<boolean> {
    const record = await store.read(sessionId)
    if (!record) return false
    // Sessions from before this check, or whose sign-in brought no refresh token.
    if (!record.refreshToken) {
      await store.end(sessionId)
      return false
    }
    const time = now()
    if (record.checkedAt && time.getTime() - record.checkedAt.getTime() < intervalMs) return true

    const result = await refresh(record.refreshToken)
    if (result.status === 'ended') {
      // Another server process may have spent the same token a moment earlier; where Keycloak
      // revokes used tokens, this one is then refused although the session lives on.
      const latest = await store.read(sessionId)
      if (latest?.refreshToken && latest.refreshToken !== record.refreshToken) return true
      await store.end(sessionId)
      return false
    }
    if (result.status === 'active') await store.save(sessionId, result.refreshToken, time)
    // Without an answer the next try waits an interval as well, so an outage neither ends
    // sessions nor slows every request down.
    else await store.postpone(sessionId, time)
    return true
  }

  return {
    check(sessionId) {
      const pending = running.get(sessionId)
      if (pending) return pending
      const next = run(sessionId).finally(() => running.delete(sessionId))
      running.set(sessionId, next)
      return next
    }
  }
}

/** Refreshes a Keycloak session with the confidential client's credentials. */
export function keycloakTokenRefresher(options: {
  issuer: string
  clientId: string
  clientSecret: string
  fetch?: typeof fetch
  timeoutMs?: number
}): (refreshToken: string) => Promise<KeycloakRefresh> {
  const { issuer, clientId, clientSecret, fetch: send = fetch, timeoutMs = 5_000 } = options
  const tokenUrl = `${issuer.replace(/\/+$/, '')}/protocol/openid-connect/token`

  return async (refreshToken) => {
    let response: Response
    try {
      response = await send(tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret
        }),
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch (error) {
      console.warn('Keycloak session check failed: token endpoint unreachable', error)
      return { status: 'unavailable' }
    }
    const body = (await response.json().catch(() => null)) as {
      refresh_token?: unknown
      error?: unknown
    } | null
    if (response.ok && typeof body?.refresh_token === 'string') {
      return { status: 'active', refreshToken: body.refresh_token }
    }
    // Keycloak answers `invalid_grant` for an ended session, an expired or revoked token and a
    // disabled user; anything else (a wrong client secret, an outage) is not the user's doing.
    if (response.status === 400 && body?.error === 'invalid_grant') return { status: 'ended' }
    console.warn(
      `Keycloak session check failed: token endpoint answered ${response.status}`,
      typeof body?.error === 'string' ? body.error : ''
    )
    return { status: 'unavailable' }
  }
}
