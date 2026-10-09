import { COMPONENT_WIDGETS, widgetRefKey, type ComponentType } from '@justcampus/shared'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { genericOAuth, keycloak, type GenericOAuthConfig } from 'better-auth/plugins/generic-oauth'
import type { Context } from 'hono'
import { randomUUID } from 'node:crypto'

import { db } from './db/index.js'
import * as schema from './db/schema.js'
import { env } from './env.js'
import { createKeycloakSessionKeeper, keycloakTokenRefresher } from './keycloak-session.js'
import {
  filterLayout,
  freshDashboardIds,
  groupsFromIdToken,
  pickPreset,
  profileFromIdToken,
  rolesFromIdToken
} from './logic.js'

const keycloakConfig: GenericOAuthConfig = {
  ...keycloak({
    issuer: env.KEYCLOAK_ISSUER,
    clientId: env.KEYCLOAK_CLIENT_ID,
    clientSecret: env.KEYCLOAK_CLIENT_SECRET,
    pkce: true,
    scopes: ['openid', 'profile', 'email'],
    postLogoutRedirectURI: env.WEB_ORIGIN
  }),
  mapProfileToUser: (profile) => {
    const email = typeof profile.email === 'string' ? profile.email : ''
    const fullName = [profile.given_name, profile.family_name]
      .filter((part): part is string => typeof part === 'string' && part.length > 0)
      .join(' ')

    return {
      name:
        typeof profile.name === 'string' && profile.name.length > 0
          ? profile.name
          : fullName || email,
      email,
      image: typeof profile.picture === 'string' ? profile.picture : undefined
    }
  },
  overrideUserInfo: true
}

/**
 * Syncs Keycloak audiences, profile claims and sign-in time without changing
 * the app role.
 */
async function syncKeycloakAccount(account: {
  providerId: string
  userId: string
  idToken?: string | null
}): Promise<void> {
  if (account.providerId !== 'keycloak' || !account.idToken) return
  const roles = rolesFromIdToken(account.idToken)
  const groups = groupsFromIdToken(account.idToken)
  await db
    .update(schema.user)
    .set({
      ...profileFromIdToken(account.idToken),
      keycloakRoles: roles,
      keycloakGroups: groups,
      lastSignInAt: new Date(),
      updatedAt: new Date()
    })
    .where(eq(schema.user.id, account.userId))

  try {
    await initializeLayout(account.userId, roles, groups)
  } catch (error) {
    console.error(`Could not initialize layout for user ${account.userId}`, error)
  }
}

async function initializeLayout(
  userId: string,
  roles: readonly string[],
  groups: readonly string[]
): Promise<void> {
  await db.transaction(async (transaction) => {
    const [claimed] = await transaction
      .update(schema.user)
      .set({ layoutInitializedAt: new Date() })
      .where(and(eq(schema.user.id, userId), isNull(schema.user.layoutInitializedAt)))
      .returning({ id: schema.user.id })
    if (!claimed) return

    const presets = await transaction
      .select()
      .from(schema.layoutPreset)
      .orderBy(asc(schema.layoutPreset.sortOrder))
    const preset = pickPreset(presets, roles, groups)
    if (!preset) return

    const enabled = await transaction
      .select({ id: schema.component.id, type: schema.component.type })
      .from(schema.component)
      .where(eq(schema.component.enabled, true))
    const enabledComponentIds = new Set(enabled.map(({ id }) => id))
    const enabledWidgetRefs = new Set(
      enabled.flatMap(({ id, type }) =>
        Object.keys(COMPONENT_WIDGETS[type as ComponentType]).map((widgetKey) =>
          widgetRefKey({ componentId: id, widgetKey })
        )
      )
    )
    const filtered = filterLayout(
      preset.sidebar,
      preset.dashboard,
      enabledComponentIds,
      enabledWidgetRefs
    )
    const dashboard = freshDashboardIds(filtered.dashboard, randomUUID)

    if (filtered.sidebar.componentIds.length > 0) {
      await transaction.insert(schema.sidebarEntry).values(
        filtered.sidebar.componentIds.map((componentId, position) => ({
          userId,
          componentId,
          position
        }))
      )
    }
    if (dashboard.tiles.length === 0) return
    await transaction.insert(schema.dashboardTile).values(
      dashboard.tiles.map((tile) => ({
        id: tile.id,
        userId,
        kind: tile.kind,
        componentId: tile.kind === 'widget' ? tile.componentId : null,
        widgetKey: tile.kind === 'widget' ? tile.widgetKey : null,
        title:
          tile.kind === 'folder' || tile.kind === 'link' || tile.kind === 'feed'
            ? tile.title
            : null,
        url: tile.kind === 'link' ? tile.url : tile.kind === 'feed' ? tile.feedUrl : null,
        icon: tile.kind === 'folder' || tile.kind === 'link' ? (tile.icon ?? null) : null,
        x: tile.x,
        y: tile.y,
        w: tile.w,
        h: tile.h
      }))
    )
    const folderItems = dashboard.tiles.flatMap((tile) =>
      tile.kind === 'folder'
        ? tile.items.map((item, position) => ({
            id: item.kind === 'link' ? item.id : undefined,
            tileId: tile.id,
            kind: item.kind,
            componentId: item.kind === 'widget' ? item.componentId : null,
            widgetKey: item.kind === 'widget' ? item.widgetKey : null,
            title: item.kind === 'link' ? item.title : null,
            url: item.kind === 'link' ? item.url : null,
            icon: item.kind === 'link' ? item.icon : null,
            position
          }))
        : []
    )
    if (folderItems.length > 0) {
      await transaction.insert(schema.dashboardFolderItem).values(folderItems)
    }
  })
}

const keycloakSessions = createKeycloakSessionKeeper({
  refresh: keycloakTokenRefresher({
    issuer: env.KEYCLOAK_ISSUER,
    clientId: env.KEYCLOAK_CLIENT_ID,
    clientSecret: env.KEYCLOAK_CLIENT_SECRET
  }),
  store: {
    async read(sessionId) {
      const [record] = await db
        .select({
          refreshToken: schema.session.keycloakRefreshToken,
          checkedAt: schema.session.keycloakCheckedAt
        })
        .from(schema.session)
        .where(eq(schema.session.id, sessionId))
        .limit(1)
      return record ?? null
    },
    async save(sessionId, refreshToken, checkedAt) {
      await db
        .update(schema.session)
        .set({ keycloakRefreshToken: refreshToken, keycloakCheckedAt: checkedAt })
        .where(eq(schema.session.id, sessionId))
    },
    async postpone(sessionId, checkedAt) {
      await db
        .update(schema.session)
        .set({ keycloakCheckedAt: checkedAt })
        .where(eq(schema.session.id, sessionId))
    },
    async end(sessionId) {
      await db.delete(schema.session).where(eq(schema.session.id, sessionId))
    }
  }
})

/**
 * The Keycloak refresh token of each sign-in request, by Better-Auth's endpoint context: the
 * account hook stores it and the session hook of the same request takes it. Reading it back from
 * the account row instead could pick up the token of another device signing in at the same time.
 */
const signInRefreshTokens = new WeakMap<object, string>()

function rememberSignInToken(
  account: { providerId: string; refreshToken?: string | null },
  context: object | null
): void {
  if (context && account.providerId === 'keycloak' && account.refreshToken) {
    signInRefreshTokens.set(context, account.refreshToken)
  }
}

/** Hands a new session the Keycloak refresh token of the sign-in that created it. */
async function bindKeycloakSession(session: { id: string }, context: object | null): Promise<void> {
  const refreshToken = context ? signInRefreshTokens.get(context) : undefined
  if (!refreshToken) return
  await db
    .update(schema.session)
    .set({ keycloakRefreshToken: refreshToken, keycloakCheckedAt: new Date() })
    .where(eq(schema.session.id, session.id))
}

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg', schema }),
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: env.CORS_ORIGINS,
  session: { cookieCache: { enabled: false } },
  user: {
    additionalFields: {
      language: { type: 'string', required: false, input: true }
    }
  },
  databaseHooks: {
    account: {
      create: {
        after: async (account, context) => {
          rememberSignInToken(account, context)
          await syncKeycloakAccount(account)
        }
      },
      update: {
        after: async (account, context) => {
          rememberSignInToken(account, context)
          await syncKeycloakAccount(account)
        }
      }
    },
    session: {
      create: { after: (session, context) => bindKeycloakSession(session, context) }
    }
  },
  // Nothing uses the account's Keycloak tokens; refreshing them here would compete with the
  // session's own refresh token (`keycloak-session.ts`) where Keycloak revokes used tokens.
  disabledPaths: ['/refresh-token', '/get-access-token'],
  advanced: {
    useSecureCookies: true,
    defaultCookieAttributes: { sameSite: 'none', secure: true }
  },
  plugins: [genericOAuth({ config: [keycloakConfig] })]
})

export type AuthSession = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>

/** The request's session, `null` when there is none or its Keycloak session has ended. */
export async function getSession(context: Context): Promise<AuthSession | null> {
  const session = await auth.api.getSession({
    headers: context.req.raw.headers,
    query: { disableCookieCache: true }
  })
  if (!session) return null
  return (await keycloakSessions.check(session.session.id)) ? session : null
}
