import { describe, expect, it } from 'vitest'

import { isTrustedRequest, isTrustedWebSocketOrigin, trustedOrigins } from './origin.js'

const trusted = ['http://localhost:5173', 'app://-', 'http://localhost:3000']

describe('isTrustedRequest', () => {
  it('lets reads through from anywhere', () => {
    expect(isTrustedRequest('GET', 'https://evil.example', trusted)).toBe(true)
    expect(isTrustedRequest('OPTIONS', 'https://evil.example', trusted)).toBe(true)
  })

  it('takes writes from the trusted origins', () => {
    expect(isTrustedRequest('POST', 'http://localhost:5173', trusted)).toBe(true)
    expect(isTrustedRequest('DELETE', 'app://-', trusted)).toBe(true)
  })

  it('refuses writes from other sites and opaque origins', () => {
    expect(isTrustedRequest('POST', 'https://evil.example', trusted)).toBe(false)
    expect(isTrustedRequest('PUT', 'null', trusted)).toBe(false)
  })

  it('takes writes without an origin, which do not come from a browser page', () => {
    expect(isTrustedRequest('POST', undefined, trusted)).toBe(true)
  })
})

describe('isTrustedWebSocketOrigin', () => {
  it('takes upgrades from the trusted origins only, and none without an origin', () => {
    expect(isTrustedWebSocketOrigin('http://localhost:5173', trusted)).toBe(true)
    expect(isTrustedWebSocketOrigin('app://-', trusted)).toBe(true)
    expect(isTrustedWebSocketOrigin('https://evil.example', trusted)).toBe(false)
    expect(isTrustedWebSocketOrigin('null', trusted)).toBe(false)
    expect(isTrustedWebSocketOrigin(undefined, trusted)).toBe(false)
  })

  it('trusts the web origins and the API’s own', () => {
    expect(trustedOrigins(['app://-'], 'https://campus.example/api/auth')).toEqual([
      'app://-',
      'https://campus.example'
    ])
  })
})
