import { describe, expect, it } from 'vitest'
import { ApiRequestError } from './api'
import {
  filterUsers,
  formatUserDate,
  isRoleConflict,
  parseAdminUsersSearch,
  userInitials
} from './admin-users'

const users = [
  { name: 'Jana Müller', email: 'jana.mueller@uni-giessen.de' },
  { name: 'Ömer Yıldız', email: 'oemer.yildiz@uni-giessen.de' },
  { name: 'Max Späth', email: 'max.spaeth@hrz.uni-giessen.de' }
]

describe('filterUsers', () => {
  it('keeps every user, in order, for an empty query', () => {
    expect(filterUsers(users, '  ')).toEqual(users)
  })

  it('matches name or e-mail regardless of case and accents', () => {
    expect(filterUsers(users, 'MULLER')).toEqual([users[0]])
    expect(filterUsers(users, 'omer')).toEqual([users[1]])
    expect(filterUsers(users, '@hrz.')).toEqual([users[2]])
  })

  it('needs every word, each in the name or the e-mail', () => {
    expect(filterUsers(users, 'max hrz')).toEqual([users[2]])
    expect(filterUsers(users, 'jana hrz')).toEqual([])
  })
})

describe('userInitials', () => {
  it('takes the first and last name', () => {
    expect(userInitials({ name: 'Anna Lena Schmidt', email: 'a@b.de' })).toBe('AS')
    expect(userInitials({ name: 'ömer', email: 'o@b.de' })).toBe('Ö')
  })

  it('falls back to the e-mail without a name', () => {
    expect(userInitials({ name: ' ', email: 'jana@uni-giessen.de' })).toBe('J')
  })
})

describe('formatUserDate', () => {
  it('writes the date in the given language', () => {
    expect(formatUserDate('2026-09-01T10:00:00.000Z', 'de')).toContain('2026')
    expect(formatUserDate('2026-09-01T10:00:00.000Z', 'en')).toContain('Sep')
  })
})

describe('parseAdminUsersSearch', () => {
  it('keeps a user id only', () => {
    expect(parseAdminUsersSearch({ user: 'u1', other: 'x' })).toEqual({ user: 'u1' })
    expect(parseAdminUsersSearch({ user: '' })).toEqual({})
    expect(parseAdminUsersSearch({ user: 3 })).toEqual({})
  })
})

describe('isRoleConflict', () => {
  it('tells a conflict from other failures', () => {
    const conflict = new ApiRequestError(409, {
      error: { code: 'conflict', message: 'The app needs an admin' }
    })
    expect(isRoleConflict(conflict)).toBe(true)
    expect(isRoleConflict(new ApiRequestError(500, null))).toBe(false)
    expect(isRoleConflict(new TypeError('offline'))).toBe(false)
  })
})
