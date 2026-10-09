import {
  FEATURE_KEYS,
  type FeatureKey,
  widgetRefKey,
  type Dashboard,
  type Sidebar,
  type WidgetRef
} from '@justcampus/shared'

export function isCompleteOrder(
  currentIds: readonly string[],
  requestedIds: readonly string[]
): boolean {
  if (
    currentIds.length !== requestedIds.length ||
    new Set(requestedIds).size !== requestedIds.length
  ) {
    return false
  }

  const current = new Set(currentIds)
  return requestedIds.every((id) => current.has(id))
}

export interface FolderTemplateRow {
  id: string
  name: string
  icon: string | null
  enabled: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export interface FolderTemplateItemRow {
  templateId: string
  componentId: string
  widgetKey: string
}

/** Joins ordered template items and optionally hides disabled widgets for users. */
export function assembleFolderTemplates(
  rows: readonly FolderTemplateRow[],
  items: readonly FolderTemplateItemRow[],
  enabledWidgetRefs?: ReadonlySet<string>
): Array<FolderTemplateRow & { widgets: WidgetRef[] }> {
  const itemRefs = new Map<string, WidgetRef[]>()
  for (const item of items) {
    const ref = { componentId: item.componentId, widgetKey: item.widgetKey }
    if (enabledWidgetRefs && !enabledWidgetRefs.has(widgetRefKey(ref))) continue
    const refs = itemRefs.get(item.templateId) ?? []
    refs.push(ref)
    itemRefs.set(item.templateId, refs)
  }
  return rows.map((row) => ({ ...row, widgets: itemRefs.get(row.id) ?? [] }))
}

export interface TileRow {
  id: string
  kind: string
  componentId: string | null
  widgetKey: string | null
  title: string | null
  url: string | null
  icon: string | null
  x: number
  y: number
  w: number
  h: number
}

export interface FolderItemRow {
  id: string
  tileId: string
  kind: string
  componentId: string | null
  widgetKey: string | null
  title: string | null
  url: string | null
  icon: string | null
}

export type TileOut =
  | {
      kind: 'widget'
      id: string
      componentId: string
      widgetKey: string
      x: number
      y: number
      w: number
      h: number
    }
  | {
      kind: 'folder'
      id: string
      title: string
      icon: string | null
      items: Array<
        | { kind: 'widget'; componentId: string; widgetKey: string }
        | { kind: 'link'; id: string; title: string; url: string; icon: string | null }
      >
      x: number
      y: number
      w: number
      h: number
    }
  | {
      kind: 'link'
      id: string
      title: string
      url: string
      icon: string | null
      x: number
      y: number
      w: number
      h: number
    }
  | {
      kind: 'feed'
      id: string
      title: string | null
      feedUrl: string
      x: number
      y: number
      w: number
      h: number
    }

/**
 * Tiles as the client sees them: widget tiles of disabled components are left out,
 * folders keep their links and enabled widgets (items are expected in position order).
 */
export function assembleTiles(
  rows: readonly TileRow[],
  items: readonly FolderItemRow[],
  enabledWidgetRefs: ReadonlySet<string>
): TileOut[] {
  type FolderItems = Extract<TileOut, { kind: 'folder' }>['items']
  const itemsByTile = new Map<string, FolderItems>()
  for (const item of items) {
    let output: FolderItems[number] | null = null
    if (item.kind === 'widget') {
      if (!item.componentId || !item.widgetKey) continue
      const ref = { componentId: item.componentId, widgetKey: item.widgetKey }
      if (!enabledWidgetRefs.has(widgetRefKey(ref))) continue
      output = { kind: 'widget', ...ref }
    } else if (item.kind === 'link' && item.title && item.url) {
      output = {
        kind: 'link',
        id: item.id,
        title: item.title,
        url: item.url,
        icon: item.icon
      }
    }
    if (!output) continue
    const list = itemsByTile.get(item.tileId) ?? []
    list.push(output)
    itemsByTile.set(item.tileId, list)
  }
  return rows.flatMap((row): TileOut[] => {
    const geometry = { id: row.id, x: row.x, y: row.y, w: row.w, h: row.h }
    if (row.kind === 'folder') {
      return [
        {
          kind: 'folder' as const,
          ...geometry,
          title: row.title ?? '',
          icon: row.icon,
          items: itemsByTile.get(row.id) ?? []
        }
      ]
    }
    if (row.kind === 'link' && row.title && row.url) {
      return [{ kind: 'link', ...geometry, title: row.title, url: row.url, icon: row.icon }]
    }
    if (row.kind === 'feed' && row.url) {
      return [{ kind: 'feed', ...geometry, title: row.title, feedUrl: row.url }]
    }
    if (!row.componentId || !row.widgetKey) return []
    const ref = { componentId: row.componentId, widgetKey: row.widgetKey }
    if (!enabledWidgetRefs.has(widgetRefKey(ref))) return []
    return [{ kind: 'widget' as const, ...geometry, ...ref }]
  })
}

export function widgetRefsFromDashboard(dashboard: Dashboard): WidgetRef[] {
  return dashboard.tiles.flatMap((tile) => {
    if (tile.kind === 'widget') {
      return [{ componentId: tile.componentId, widgetKey: tile.widgetKey }]
    }
    if (tile.kind !== 'folder') return []
    return tile.items.flatMap((item) =>
      item.kind === 'widget' ? [{ componentId: item.componentId, widgetKey: item.widgetKey }] : []
    )
  })
}

/** Applies the same disabled-component visibility rules as sidebar and dashboard reads. */
export function filterLayout(
  sidebar: Sidebar,
  dashboard: Dashboard,
  enabledComponentIds: ReadonlySet<string>,
  enabledWidgetRefs: ReadonlySet<string>
): { sidebar: Sidebar; dashboard: Dashboard } {
  return {
    sidebar: {
      componentIds: sidebar.componentIds.filter((id) => enabledComponentIds.has(id))
    },
    dashboard: {
      tiles: dashboard.tiles.flatMap((tile): Dashboard['tiles'] => {
        if (tile.kind === 'widget') {
          return enabledWidgetRefs.has(widgetRefKey(tile)) ? [tile] : []
        }
        if (tile.kind !== 'folder') return [tile]
        return [
          {
            ...tile,
            items: tile.items.filter(
              (item) => item.kind === 'link' || enabledWidgetRefs.has(widgetRefKey(item))
            )
          }
        ]
      })
    }
  }
}

/** Replaces every persisted client id before copying a preset to a user. */
export function freshDashboardIds(dashboard: Dashboard, createId: () => string): Dashboard {
  return {
    tiles: dashboard.tiles.map((tile) => ({
      ...tile,
      id: createId(),
      ...(tile.kind === 'folder'
        ? {
            items: tile.items.map((item) =>
              item.kind === 'link' ? { ...item, id: createId() } : item
            )
          }
        : {})
    }))
  } as Dashboard
}

export interface PresetMatchRow {
  audienceKind: string
  audienceName: string | null
  sortOrder: number
}

/** Finds the first matching named audience, with `everyone` reserved as the fallback. */
export function pickPreset<T extends PresetMatchRow>(
  presets: readonly T[],
  roles: readonly string[],
  groups: readonly string[]
): T | undefined {
  const roleSet = new Set(roles)
  const groupSet = new Set(groups)
  const ordered = [...presets].sort((left, right) => left.sortOrder - right.sortOrder)
  const match = ordered.find(
    (preset) =>
      (preset.audienceKind === 'role' &&
        preset.audienceName !== null &&
        roleSet.has(preset.audienceName)) ||
      (preset.audienceKind === 'group' &&
        preset.audienceName !== null &&
        groupSet.has(preset.audienceName))
  )
  return match ?? ordered.find((preset) => preset.audienceKind === 'everyone')
}

function claimsFromIdToken(idToken: string): Record<string, unknown> | null {
  const payload = idToken.split('.')[1]
  if (!payload) return null
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return typeof claims === 'object' && claims !== null
      ? (claims as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/**
 * Reads the `roles` claim from a Keycloak ID token without verifying it. Only
 * call this with a token Better-Auth has just verified against the realm's
 * JWKS and stored; it is a decoder, not a validator. Supports the flat
 * `roles` claim from our mapper and Keycloak's default `realm_access.roles`.
 */
export function rolesFromIdToken(idToken: string): string[] {
  const claims = claimsFromIdToken(idToken)
  if (!claims) return []
  const flat = claims.roles
  if (Array.isArray(flat)) return flat.filter((role): role is string => typeof role === 'string')
  const realmAccess = claims.realm_access
  if (typeof realmAccess !== 'object' || realmAccess === null) return []
  const nested = (realmAccess as { roles?: unknown }).roles
  if (Array.isArray(nested)) {
    return nested.filter((role): role is string => typeof role === 'string')
  }
  return []
}

/** Reads the string entries from Keycloak's `groups` ID-token claim. */
export function groupsFromIdToken(idToken: string): string[] {
  const groups = claimsFromIdToken(idToken)?.groups
  return Array.isArray(groups)
    ? groups.filter((group): group is string => typeof group === 'string')
    : []
}

export interface IdTokenProfile {
  username: string | null
  givenName: string | null
  familyName: string | null
}

/** Reads the profile claims shown in the settings; missing or empty ones become `null`. */
export function profileFromIdToken(idToken: string): IdTokenProfile {
  const claims = claimsFromIdToken(idToken)
  const text = (claim: string): string | null => {
    const value = claims?.[claim]
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
  }
  return {
    username: text('preferred_username'),
    givenName: text('given_name'),
    familyName: text('family_name')
  }
}

/** Which of a tile's axes fall below the widget's minimum: `[]` when it fits. */
export function tooSmall(
  tile: { w: number; h: number },
  minimum: { minW: number; minH: number }
): Array<'w' | 'h'> {
  const axes: Array<'w' | 'h'> = []
  if (tile.w < minimum.minW) axes.push('w')
  if (tile.h < minimum.minH) axes.push('h')
  return axes
}

export interface AccessRole {
  id: string
  builtIn: 'everyone' | 'admin' | null
  keycloakRoles: readonly string[]
  keycloakGroups: readonly string[]
  componentIds: readonly string[]
  features: readonly FeatureKey[]
}

export interface RoleClaims {
  keycloakRoles: readonly string[]
  keycloakGroups: readonly string[]
}

/** Keycloak names match exactly, including group paths and case. */
export function keycloakRoleIds(roles: readonly AccessRole[], claims: RoleClaims): string[] {
  return roles
    .filter(
      (role) =>
        role.builtIn !== 'everyone' &&
        (role.keycloakRoles.some((name) => claims.keycloakRoles.includes(name)) ||
          role.keycloakGroups.some((name) => claims.keycloakGroups.includes(name)))
    )
    .map(({ id }) => id)
}

export function heldRoles<T extends AccessRole>(
  roles: readonly T[],
  manualRoleIds: readonly string[],
  claims: RoleClaims
): T[] {
  const automatic = new Set(keycloakRoleIds(roles, claims))
  return roles.filter(
    (role) =>
      role.builtIn === 'everyone' || manualRoleIds.includes(role.id) || automatic.has(role.id)
  )
}

export interface UserAccess {
  isAdmin: boolean
  componentIds: Set<string>
  features: Set<FeatureKey>
}

export function roleAccess(
  roles: readonly AccessRole[],
  manualRoleIds: readonly string[],
  claims: RoleClaims,
  allComponentIds: readonly string[]
): UserAccess {
  const held = heldRoles(roles, manualRoleIds, claims)
  const isAdmin = held.some((role) => role.builtIn === 'admin')
  return {
    isAdmin,
    componentIds: new Set(isAdmin ? allComponentIds : held.flatMap((role) => role.componentIds)),
    features: new Set(isAdmin ? FEATURE_KEYS : held.flatMap((role) => role.features))
  }
}
