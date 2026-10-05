import { describe, expect, it, vi } from 'vitest'

vi.mock('./db/index.js', () => ({ db: {} }))

import { orderAdminUsers, requireRoleChange, toAdminUser } from './admin-users.js'
import { ApiError } from './api.js'

describe('admin users', () => {
  const rows = [
    { id: 'a', role: 'admin', name: 'zoe' },
    { id: 'b', role: 'admin', name: 'Alice' },
    { id: 'c', role: 'user', name: 'bob' },
    { id: 'd', role: 'user', name: 'Aaron' }
  ]

  it('orders admins first, then names without case sensitivity', () => {
    expect(orderAdminUsers(rows).map((row) => row.id)).toEqual(['b', 'a', 'd', 'c'])
    expect(rows.map((row) => row.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('allows grants, other-admin revocations and unchanged roles', () => {
    expect(() => requireRoleChange(rows, 'a', 'c', 'admin')).not.toThrow()
    expect(() => requireRoleChange(rows, 'a', 'b', 'user')).not.toThrow()
    expect(() => requireRoleChange(rows, 'a', 'a', 'admin')).not.toThrow()
    expect(() => requireRoleChange(rows, 'a', 'c', 'user')).not.toThrow()
  })

  it('rejects self-revocation and revoking the only remaining admin', () => {
    expect(() => requireRoleChange(rows, 'a', 'a', 'user')).toThrow(ApiError)
    expect(() => requireRoleChange([rows[0]!], 'a', 'a', 'user')).toThrow(
      expect.objectContaining({ status: 409, code: 'conflict' })
    )
  })

  it('rechecks the acting admin after a concurrent revocation', () => {
    const afterRevocation = rows.map((row) => (row.id === 'b' ? { ...row, role: 'user' } : row))
    expect(() => requireRoleChange(afterRevocation, 'b', 'a', 'user')).toThrow(
      'At least one admin must remain'
    )
    expect(() => requireRoleChange(rows, 'c', 'a', 'user')).toThrow('Admin role required')
  })

  it('returns not_found for an unknown target', () => {
    expect(() => requireRoleChange(rows, 'a', 'missing', 'admin')).toThrow(
      expect.objectContaining({ status: 404, code: 'not_found' })
    )
  })

  it('serializes dates and omits fields outside the shared contract', () => {
    const now = new Date('2026-10-04T12:00:00Z')
    const row = {
      id: 'a',
      name: 'Alice',
      email: 'alice@example.com',
      image: null,
      role: 'admin',
      username: null,
      givenName: null,
      familyName: null,
      language: null,
      emailVerified: true,
      keycloakRoles: ['user'],
      keycloakGroups: [],
      createdAt: now,
      updatedAt: now,
      lastSignInAt: now,
      layoutInitializedAt: now
    }
    expect(toAdminUser(row)).toEqual({
      id: 'a',
      name: 'Alice',
      email: 'alice@example.com',
      image: null,
      role: 'admin',
      keycloakRoles: ['user'],
      keycloakGroups: [],
      createdAt: now.toISOString(),
      lastSignInAt: now.toISOString()
    })
    expect(toAdminUser({ ...row, lastSignInAt: null }).lastSignInAt).toBeNull()
  })
})
