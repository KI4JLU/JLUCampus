import { describe, expect, it, vi } from 'vitest'

vi.mock('./db/index.js', () => ({ db: {} }))

import type { RoleRow } from './access.js'
import { orderAdminUsers, requireAdminContinuity, toAdminUser } from './admin-users.js'
import { user } from './db/schema.js'

const now = new Date('2026-10-04T12:00:00Z')
const adminId = '00000000-0000-4000-8000-000000000001'
const everyoneId = '00000000-0000-4000-8000-000000000002'
const roles: RoleRow[] = [
  {
    id: adminId,
    builtIn: 'admin',
    name: 'Admin',
    keycloakRoles: ['staff'],
    keycloakGroups: ['/admins'],
    features: [],
    componentIds: [],
    createdAt: now,
    updatedAt: now
  },
  {
    id: everyoneId,
    builtIn: 'everyone',
    name: 'Alle Nutzenden',
    keycloakRoles: [],
    keycloakGroups: [],
    features: [],
    componentIds: [],
    createdAt: now,
    updatedAt: now
  }
]
const row: typeof user.$inferSelect = {
  id: 'alice',
  name: 'Alice',
  email: 'alice@example.com',
  image: null,
  username: null,
  givenName: null,
  familyName: null,
  language: null,
  emailVerified: true,
  keycloakRoles: [],
  keycloakGroups: [],
  createdAt: now,
  updatedAt: now,
  lastSignInAt: now,
  layoutInitializedAt: now
}
const admin = toAdminUser(row, roles, [{ roleId: adminId, userId: row.id, createdAt: now }])
const bob = toAdminUser({ ...row, id: 'bob' }, roles, [])

describe('admin users', () => {
  it('orders effective admins first, then names without case sensitivity', () => {
    const rows = [
      { ...admin, id: 'a', name: 'zoe' },
      { ...admin, id: 'b', name: 'Alice' },
      { ...bob, id: 'c', name: 'bob' },
      { ...bob, id: 'd', name: 'Aaron' }
    ]
    expect(orderAdminUsers(rows).map((row) => row.id)).toEqual(['b', 'a', 'd', 'c'])
    expect(rows.map((row) => row.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('serializes manual and Keycloak memberships, excluding everyone', () => {
    const output = toAdminUser({ ...row, keycloakRoles: ['staff'] }, roles, [
      { roleId: adminId, userId: 'alice', createdAt: now },
      { roleId: everyoneId, userId: 'alice', createdAt: now },
      { roleId: adminId, userId: 'bob', createdAt: now }
    ])
    expect(output).toEqual({
      id: 'alice',
      name: 'Alice',
      email: 'alice@example.com',
      image: null,
      role: 'admin',
      roleIds: [adminId],
      keycloakRoleIds: [adminId],
      keycloakRoles: ['staff'],
      keycloakGroups: [],
      createdAt: now.toISOString(),
      lastSignInAt: now.toISOString()
    })
    expect(
      toAdminUser({ ...row, keycloakGroups: ['/admins'], lastSignInAt: null }, roles, [])
    ).toMatchObject({ role: 'admin', roleIds: [], keycloakRoleIds: [adminId], lastSignInAt: null })
  })

  it('allows revocations that keep the acting admin and an effective admin', () => {
    expect(() =>
      requireAdminContinuity([admin, { ...bob, role: 'admin' }], [admin, bob], 'alice')
    ).not.toThrow()
    expect(() => requireAdminContinuity([admin], [admin], 'alice')).not.toThrow()
  })

  it('refuses self-revocation even when another effective admin remains', () => {
    expect(() =>
      requireAdminContinuity(
        [admin, bob],
        [
          { ...admin, role: 'user' },
          { ...bob, role: 'admin' }
        ],
        'alice'
      )
    ).toThrow('You cannot revoke your own admin role')
  })

  it('protects the last effective admin and rechecks a revoked actor', () => {
    expect(() => requireAdminContinuity([admin], [{ ...admin, role: 'user' }])).toThrow(
      'At least one admin must remain'
    )
    expect(() => requireAdminContinuity([admin, bob], [admin, bob], 'bob')).toThrow(
      'Admin role required'
    )
  })
})
