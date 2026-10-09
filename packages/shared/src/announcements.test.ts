import { describe, expect, it } from 'vitest'

import {
  adminAnnouncementSchema,
  announcementInputSchema,
  announcementPathMatches,
  announcementTargetSchema
} from './announcements'

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
        target: { selector: '[data-tour="more-apps"]', path: '/c/*' },
        enabled: true,
        texts
      }).success
    ).toBe(true)
  })

  it('rejects a path with a * in the middle', () => {
    expect(
      announcementInputSchema.safeParse({
        kind: 'hint',
        target: { selector: 'button', path: '/c/*/x' },
        enabled: true,
        texts
      }).success
    ).toBe(false)
  })

  it('drops the side stored with older hints', () => {
    const stored = { selector: '#more-apps', path: null, side: 'right' }
    expect(announcementTargetSchema.parse(stored)).toEqual({ selector: '#more-apps', path: null })
    const parsed = adminAnnouncementSchema.parse({
      id: '00000000-0000-4000-8000-000000000001',
      kind: 'hint',
      target: stored,
      enabled: true,
      texts,
      publishedAt: '2026-10-01T00:00:00.000Z',
      seenCount: 0,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z'
    })
    expect(parsed.target).toEqual({ selector: '#more-apps', path: null })
  })
})
