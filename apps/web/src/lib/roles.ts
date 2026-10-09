import type { TFunction } from 'i18next'
import {
  appRoleInputSchema,
  FEATURE_KEYS,
  featureModule,
  ROLE_NAME_MAX,
  ROLE_RULES_MAX,
  type AdminUser,
  type AppRole,
  type AppRoleInput,
  type FeatureKey,
  type SingletonComponentType
} from '@justcampus/shared'
import { ApiRequestError } from './api'
import type { FieldErrors } from './component-form'

/** A role's name as the admin reads it: built-in roles under their translated name. */
export function roleName(role: Pick<AppRole, 'builtIn' | 'name'>, t: TFunction): string {
  return role.builtIn ? t(`admin.roles.builtIn.${role.builtIn}`) : role.name
}

/** What a role grants, for the list: everything (admin), nothing, or how much of each. */
export type PermissionSummary =
  { kind: 'all' } | { kind: 'none' } | { kind: 'some'; components: number; features: number }

export function permissionSummary(
  role: Pick<AppRole, 'builtIn' | 'componentIds' | 'features'>
): PermissionSummary {
  if (role.builtIn === 'admin') return { kind: 'all' }
  const components = role.componentIds.length
  const features = role.features.length
  return components === 0 && features === 0
    ? { kind: 'none' }
    : { kind: 'some', components, features }
}

/** One of a user's roles, and how they hold it: by an admin's hand, through Keycloak, or both. */
export interface UserRoleEntry {
  role: AppRole
  manual: boolean
  keycloak: boolean
}

/**
 * The roles a user holds, admin first, the rest in the list's order; the everyone role, which
 * everybody holds, is left out. Ids of roles the list does not know (deleted meanwhile) drop out.
 */
export function userRoleEntries(
  user: Pick<AdminUser, 'roleIds' | 'keycloakRoleIds'>,
  roles: readonly AppRole[]
): UserRoleEntry[] {
  const entries = roles
    .filter((role) => role.builtIn !== 'everyone')
    .map((role) => ({
      role,
      manual: user.roleIds.includes(role.id),
      keycloak: user.keycloakRoleIds.includes(role.id)
    }))
    .filter((entry) => entry.manual || entry.keycloak)
  return [
    ...entries.filter((entry) => entry.role.builtIn === 'admin'),
    ...entries.filter((entry) => entry.role.builtIn !== 'admin')
  ]
}

/** The roles an admin can assign by hand: all but everyone, which everybody holds anyway. */
export function assignableRoles(roles: readonly AppRole[]): AppRole[] {
  return roles.filter((role) => role.builtIn !== 'everyone')
}

/** `ids` with `id` in it or not, in their order; a new one goes last. */
export function withId<T extends string>(ids: readonly T[], id: T, on: boolean): T[] {
  const rest = ids.filter((other) => other !== id)
  return on ? [...rest, id] : rest
}

/**
 * Names typed into a Keycloak list, added to `names`: several at once, split at commas and line
 * breaks, trimmed, each once.
 */
export function addNames(names: readonly string[], typed: string): string[] {
  const next = [...names]
  for (const part of typed.split(/[,\n]/)) {
    const name = part.trim()
    if (name && !next.includes(name)) next.push(name)
  }
  return next
}

/** The suggestions not yet in the list. */
export function remainingSuggestions(
  suggestions: readonly string[] | undefined,
  names: readonly string[]
): string[] {
  return (suggestions ?? []).filter((name) => !names.includes(name))
}

/** The module functions in contract order, grouped by their module. */
export function featuresByModule(): { module: SingletonComponentType; features: FeatureKey[] }[] {
  const groups: { module: SingletonComponentType; features: FeatureKey[] }[] = []
  for (const feature of FEATURE_KEYS) {
    const module = featureModule(feature)
    const group = groups.find((entry) => entry.module === module)
    if (group) group.features.push(feature)
    else groups.push({ module, features: [feature] })
  }
  return groups
}

export interface RoleFormState {
  name: string
  keycloakRoles: string[]
  keycloakGroups: string[]
  componentIds: string[]
  features: FeatureKey[]
}

export function initialRoleFormState(role: AppRole | null): RoleFormState {
  if (!role) {
    return { name: '', keycloakRoles: [], keycloakGroups: [], componentIds: [], features: [] }
  }
  const { name, keycloakRoles, keycloakGroups, componentIds, features } = role
  return { name, keycloakRoles, keycloakGroups, componentIds, features }
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item) => b.includes(item))
}

/** Whether the form differs from the role as saved; the order of a list does not count. */
export function isRoleFormDirty(state: RoleFormState, baseline: RoleFormState): boolean {
  return (
    state.name !== baseline.name ||
    state.keycloakRoles.join('\n') !== baseline.keycloakRoles.join('\n') ||
    state.keycloakGroups.join('\n') !== baseline.keycloakGroups.join('\n') ||
    !sameSet(state.componentIds, baseline.componentIds) ||
    !sameSet(state.features, baseline.features)
  )
}

type Issue = { path: readonly PropertyKey[]; message: string }

/** Known fields get a translated message; anything else keeps the server's wording. */
function toFieldErrors(issues: readonly Issue[], t: TFunction): FieldErrors {
  const names = t('admin.roles.form.errors.names', { max: ROLE_RULES_MAX })
  const messages: Partial<Record<string, string>> = {
    name: t('admin.roles.form.errors.name', { max: ROLE_NAME_MAX }),
    keycloakRoles: names,
    keycloakGroups: names
  }
  const errors: FieldErrors = {}
  for (const issue of issues) {
    const [first] = issue.path
    const key = first === undefined ? 'form' : String(first)
    errors[key] ??= messages[key] ?? issue.message
  }
  return errors
}

export type RoleFormValidation =
  { ok: true; input: AppRoleInput } | { ok: false; errors: FieldErrors }

/**
 * The form as the input to save. Components the catalogue no longer has (`knownComponentIds`,
 * when it is known) drop out, since the server refuses unknown ids.
 */
export function validateRoleForm(
  state: RoleFormState,
  knownComponentIds: ReadonlySet<string> | null,
  t: TFunction
): RoleFormValidation {
  const componentIds = knownComponentIds
    ? state.componentIds.filter((id) => knownComponentIds.has(id))
    : state.componentIds
  const input: AppRoleInput = { ...state, componentIds }
  const result = appRoleInputSchema.safeParse(input)
  if (result.success) return { ok: true, input }
  return { ok: false, errors: toFieldErrors(result.error.issues, t) }
}

/**
 * Server errors mapped onto the form: `409 conflict` is the admin role locking the acting admin
 * (or everyone) out, validation issues go to their fields.
 */
export function roleServerErrors(error: unknown, t: TFunction): FieldErrors | null {
  if (!(error instanceof ApiRequestError)) return null
  if (error.code === 'conflict') return { form: t('admin.roles.form.errors.lockout') }
  if (error.code !== 'validation') return null
  const issues = error.body?.error.issues ?? []
  return issues.length > 0 ? toFieldErrors(issues, t) : null
}
