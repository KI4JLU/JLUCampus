import { describe, expect, it } from 'vitest'

import { announcementInputSchema, announcementPathMatches } from './announcements'

const texts = {
  de: { title: 'Neu', body: 'Text' },
  en: { title: 'New', body: 'Text' }
}

describe('announcementPathMatches', () => {
  it('matches every page without a path', () => {
    expect(announcementPathMatches(null, '/c/abc')).toBe(true)
  })

  it('matches an exact path with or without a trailing slash', () => {
    expect(announcementPathMatches('/admin', '/admin')).toBe(true)
    expect(announcementPathMatches('/admin', '/admin/')).toBe(true)
    expect(announcementPathMatches('/admin', '/admin/users')).toBe(false)
  })

  it('matches a prefix ending in *', () => {
    expect(announcementPathMatches('/c/*', '/c/123')).toBe(true)
    expect(announcementPathMatches('/c/*', '/admin')).toBe(false)
  })
})

describe('announcementInputSchema', () => {
  it('needs both languages', () => {
    const result = announcementInputSchema.safeParse({
      kind: 'news',
      target: null,
      enabled: true,
      texts: { de: texts.de }
    })
    expect(result.success).toBe(false)
  })

  it('needs a target for hints', () => {
    expect(
      announcementInputSchema.safeParse({ kind: 'hint', target: null, enabled: true, texts })
        .success
    ).toBe(false)
    expect(
      announcementInputSchema.safeParse({
        kind: 'hint',
        target: { selector: '[data-tour="more-apps"]', path: '/c/*', side: 'right' },
        enabled: true,
        texts
      }).success
    ).toBe(true)
  })

  it('rejects a path with a * in the middle', () => {
    expect(
      announcementInputSchema.safeParse({
        kind: 'hint',
        target: { selector: 'button', path: '/c/*/x', side: 'top' },
        enabled: true,
        texts
      }).success
    ).toBe(false)
  })
})
