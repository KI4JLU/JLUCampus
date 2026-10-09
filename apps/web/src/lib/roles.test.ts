import { describe, expect, it } from 'vitest'
import type { TFunction } from 'i18next'
import { FEATURE_KEYS, ROLE_RULES_MAX, type AppRole } from '@justcampus/shared'
import { ApiRequestError } from './api'
import {
  addNames,
  assignableRoles,
  featuresByModule,
  initialRoleFormState,
  isRoleFormDirty,
  permissionSummary,
  remainingSuggestions,
  roleName,
  roleServerErrors,
  userRoleEntries,
  validateRoleForm,
  withId
} from './roles'

// Messages come back as their keys, so the tests see which one was chosen.
const t = ((key: string) => key) as unknown as TFunction

const C1 = '00000000-0000-4000-8000-000000000001'
const C2 = '00000000-0000-4000-8000-000000000002'

function role(id: string, overrides: Partial<AppRole> = {}): AppRole {
  return {
    id,
    builtIn: null,
    name: id,
    keycloakRoles: [],
    keycloakGroups: [],
    componentIds: [],
    features: [],
    memberCount: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides
  }
}

const EVERYONE = role('everyone', { builtIn: 'everyone', name: 'Everyone' })
const ADMIN = role('admin', { builtIn: 'admin', name: 'Admin' })
const STAFF = role('staff')
const TEACHERS = role('teachers')
const ROLES = [EVERYONE, ADMIN, STAFF, TEACHERS]

describe('roleName', () => {
  it('translates built-in roles and keeps custom names', () => {
    expect(roleName(EVERYONE, t)).toBe('admin.roles.builtIn.everyone')
    expect(roleName(ADMIN, t)).toBe('admin.roles.builtIn.admin')
    expect(roleName(STAFF, t)).toBe('staff')
  })
})

describe('permissionSummary', () => {
  it('grants everything to admins, whatever their lists say', () => {
    expect(permissionSummary({ ...ADMIN, componentIds: [C1] })).toEqual({ kind: 'all' })
  })

  it('counts components and functions', () => {
    expect(permissionSummary(STAFF)).toEqual({ kind: 'none' })
    expect(
      permissionSummary({ ...STAFF, componentIds: [C1, C2], features: ['translator.rephrase'] })
    ).toEqual({ kind: 'some', components: 2, features: 1 })
  })
})

describe('userRoleEntries', () => {
  it('puts admin first, keeps the list order and leaves everyone out', () => {
    const entries = userRoleEntries(
      { roleIds: ['teachers', 'everyone'], keycloakRoleIds: ['staff', 'admin'] },
      ROLES
    )
    expect(entries.map((entry) => entry.role.id)).toEqual(['admin', 'staff', 'teachers'])
  })

  it('tells manual roles from those through Keycloak, and both', () => {
    const [admin, staff] = userRoleEntries(
      { roleIds: ['admin'], keycloakRoleIds: ['admin', 'staff'] },
      ROLES
    )
    expect(admin).toMatchObject({ manual: true, keycloak: true })
    expect(staff).toMatchObject({ manual: false, keycloak: true })
  })

  it('drops roles the list does not know', () => {
    expect(userRoleEntries({ roleIds: ['gone'], keycloakRoleIds: [] }, ROLES)).toEqual([])
  })
})

describe('assignableRoles', () => {
  it('offers every role but everyone', () => {
    expect(assignableRoles(ROLES).map((entry) => entry.id)).toEqual(['admin', 'staff', 'teachers'])
  })
})

describe('withId', () => {
  it('adds at the end once and removes', () => {
    expect(withId(['a', 'b'], 'c', true)).toEqual(['a', 'b', 'c'])
    expect(withId(['a', 'b'], 'a', true)).toEqual(['b', 'a'])
    expect(withId(['a', 'b'], 'a', false)).toEqual(['b'])
  })
})

describe('addNames', () => {
  it('splits at commas and line breaks, trims and skips duplicates', () => {
    expect(addNames(['staff'], ' teacher, staff,\n/Studierende ,, ')).toEqual([
      'staff',
      'teacher',
      '/Studierende'
    ])
  })

  it('adds nothing for blank input', () => {
    expect(addNames(['staff'], ' , ')).toEqual(['staff'])
  })
})

describe('remainingSuggestions', () => {
  it('offers the names not in the list yet', () => {
    expect(remainingSuggestions(['a', 'b', 'c'], ['b'])).toEqual(['a', 'c'])
    expect(remainingSuggestions(undefined, ['b'])).toEqual([])
  })
})

describe('featuresByModule', () => {
  it('groups every function under its module, in contract order', () => {
    const groups = featuresByModule()
    expect(groups.map((group) => group.module)).toEqual(['translator', 'transcription'])
    expect(groups.flatMap((group) => group.features)).toEqual([...FEATURE_KEYS])
  })
})

describe('isRoleFormDirty', () => {
  const baseline = initialRoleFormState({
    ...STAFF,
    keycloakRoles: ['a', 'b'],
    componentIds: [C1, C2],
    features: ['translator.documents', 'translator.rephrase']
  })

  it('ignores the order of the permission lists', () => {
    expect(
      isRoleFormDirty(
        {
          ...baseline,
          componentIds: [C2, C1],
          features: ['translator.rephrase', 'translator.documents']
        },
        baseline
      )
    ).toBe(false)
  })

  it('sees changed names and lists', () => {
    expect(isRoleFormDirty({ ...baseline, name: 'other' }, baseline)).toBe(true)
    expect(isRoleFormDirty({ ...baseline, keycloakRoles: ['a'] }, baseline)).toBe(true)
    expect(isRoleFormDirty({ ...baseline, componentIds: [C1] }, baseline)).toBe(true)
  })
})

describe('validateRoleForm', () => {
  it('drops components the catalogue no longer has', () => {
    const state = { ...initialRoleFormState(null), name: ' Staff ', componentIds: [C1, C2] }
    const result = validateRoleForm(state, new Set([C2]), t)
    expect(result).toEqual({ ok: true, input: { ...state, componentIds: [C2] } })
  })

  it('keeps the components while the catalogue is unknown', () => {
    const state = { ...initialRoleFormState(null), name: 'Staff', componentIds: [C1] }
    expect(validateRoleForm(state, null, t)).toMatchObject({ ok: true })
  })

  it('names the fields that are wrong', () => {
    const tooMany = Array.from({ length: ROLE_RULES_MAX + 1 }, (_, index) => `role-${index}`)
    const result = validateRoleForm(
      { ...initialRoleFormState(null), name: '  ', keycloakGroups: tooMany },
      null,
      t
    )
    expect(result).toEqual({
      ok: false,
      errors: {
        name: 'admin.roles.form.errors.name',
        keycloakGroups: 'admin.roles.form.errors.names'
      }
    })
  })
})

describe('roleServerErrors', () => {
  it('explains a conflict as the admin lockout', () => {
    const conflict = new ApiRequestError(409, {
      error: { code: 'conflict', message: 'The app needs an admin' }
    })
    expect(roleServerErrors(conflict, t)).toEqual({ form: 'admin.roles.form.errors.lockout' })
  })

  it('maps validation issues and leaves other failures to the caller', () => {
    const invalid = new ApiRequestError(400, {
      error: {
        code: 'validation',
        message: 'Invalid',
        issues: [{ path: ['componentIds', 0], message: 'Unknown component' }]
      }
    })
    expect(roleServerErrors(invalid, t)).toEqual({ componentIds: 'Unknown component' })
    expect(roleServerErrors(new ApiRequestError(500, null), t)).toBeNull()
    expect(roleServerErrors(new TypeError('offline'), t)).toBeNull()
  })
})
