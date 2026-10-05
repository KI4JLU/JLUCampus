import { describe, expect, it } from 'vitest'

import { parseAdminArgs } from './admin-cli.js'

describe('admin CLI arguments', () => {
  it('accepts list and grants/revokes by email or id', () => {
    expect(parseAdminArgs(['list'])).toEqual({ command: 'list' })
    expect(parseAdminArgs(['grant', 'alice@example.com'])).toEqual({
      command: 'grant',
      identifier: 'alice@example.com'
    })
    expect(parseAdminArgs(['revoke', 'user-id'])).toEqual({
      command: 'revoke',
      identifier: 'user-id'
    })
  })

  it('rejects missing, unknown and extra arguments', () => {
    for (const args of [
      [],
      ['grant'],
      ['revoke', ' '],
      ['unknown'],
      ['list', 'id'],
      ['grant', 'id', 'extra']
    ]) {
      expect(parseAdminArgs(args)).toBeNull()
    }
  })
})
