import { describe, expect, it } from 'vitest'
import type { AnnouncementTexts, UserAnnouncement } from '@justcampus/shared'
import { initialAnnouncementForm } from './announcement-form'
import { ApiRequestError } from './api'
import {
  allNews,
  hintQueue,
  isPreviewFor,
  paragraphsOf,
  parsePreview,
  previewOwnedBy,
  previewPathFor,
  retrySeen,
  SEEN_RETRIES,
  SeenByOtherUserError,
  seenRetryDelay,
  serializePreview,
  textIn,
  unreadNews,
  type AnnouncementPreview
} from './announcements'

const texts = (title: string): AnnouncementTexts => ({
  de: { title: `${title} (de)`, body: 'Text' },
  en: { title: `${title} (en)`, body: 'Text' }
})

const id = (n: number): string => `00000000-0000-4000-8000-00000000000${n}`

function news(n: number, publishedAt: string, seen = false): UserAnnouncement {
  return { id: id(n), kind: 'news', target: null, texts: texts(`News ${n}`), publishedAt, seen }
}

function hint(
  n: number,
  publishedAt: string,
  path: string | null = null,
  seen = false
): UserAnnouncement {
  return {
    id: id(n),
    kind: 'hint',
    target: { selector: `#target-${n}`, path, side: 'bottom' },
    texts: texts(`Hint ${n}`),
    publishedAt,
    seen
  }
}

const announcements: UserAnnouncement[] = [
  hint(5, '2026-10-05T00:00:00.000Z', '/c/*'),
  news(4, '2026-10-04T00:00:00.000Z', true),
  hint(3, '2026-10-03T00:00:00.000Z'),
  news(2, '2026-10-02T00:00:00.000Z'),
  hint(1, '2026-10-01T00:00:00.000Z', null, true),
  news(6, '2026-10-06T00:00:00.000Z')
]

describe('textIn', () => {
  it('picks the UI language', () => {
    expect(textIn(texts('A'), 'de').title).toBe('A (de)')
    expect(textIn(texts('A'), 'en').title).toBe('A (en)')
  })
})

describe('paragraphsOf', () => {
  it('splits paragraphs at blank lines and keeps single line breaks', () => {
    expect(paragraphsOf('One\ntwo\n\nThree\n  \n\nFour')).toEqual([
      ['One', 'two'],
      ['Three'],
      ['Four']
    ])
  })

  it('handles Windows line breaks and surrounding blank lines', () => {
    expect(paragraphsOf('\r\n\r\nA\r\nB\r\n\r\nC\r\n')).toEqual([['A', 'B'], ['C']])
  })

  it('has no paragraphs for an empty body', () => {
    expect(paragraphsOf('  \n ')).toEqual([])
  })
})

describe('news', () => {
  it('lists every news item newest first', () => {
    expect(allNews(announcements).map((item) => item.id)).toEqual([id(6), id(4), id(2)])
  })

  it('opens only the unread ones, newest first', () => {
    expect(unreadNews(announcements).map((item) => item.id)).toEqual([id(6), id(2)])
  })

  it('opens nothing when every item was read', () => {
    expect(unreadNews([news(1, '2026-10-01T00:00:00.000Z', true)])).toEqual([])
  })
})

describe('hintQueue', () => {
  it('takes unread hints for the page, oldest first', () => {
    expect(hintQueue(announcements, '/c/abc').map((item) => item.id)).toEqual([id(3), id(5)])
  })

  it('leaves out hints limited to other pages', () => {
    expect(hintQueue(announcements, '/').map((item) => item.id)).toEqual([id(3)])
  })

  it('leaves out acknowledged hints and news', () => {
    const ids = hintQueue(announcements, '/c/abc').map((item) => item.id)
    expect(ids).not.toContain(id(1))
    expect(ids).not.toContain(id(2))
  })
})

describe('previewPathFor', () => {
  it('goes to an exact path as it is', () => {
    expect(previewPathFor('/admin/components')).toBe('/admin/components')
  })

  it('goes to the prefix of a wildcard path', () => {
    expect(previewPathFor('/c/*')).toBe('/c/')
    expect(previewPathFor('/*')).toBe('/')
  })

  it('goes to the dashboard for every page or a path it cannot use', () => {
    expect(previewPathFor('')).toBe('/')
    expect(previewPathFor('  ')).toBe('/')
    expect(previewPathFor('c/x')).toBe('/')
  })
})

describe('preview drafts', () => {
  const admin = { id: 'admin-1', role: 'admin' as const }
  const preview: AnnouncementPreview = {
    active: true,
    ownerId: admin.id,
    announcementId: id(3),
    form: {
      ...initialAnnouncementForm(null),
      kind: 'hint',
      selector: '[data-tour="more-apps"]',
      path: '/c/*',
      side: 'right'
    }
  }

  it('round-trips through storage', () => {
    expect(parsePreview(serializePreview(preview))).toEqual(preview)
  })

  it('ignores missing, broken and foreign values', () => {
    expect(parsePreview(null)).toBeNull()
    expect(parsePreview('{not json')).toBeNull()
    expect(parsePreview(JSON.stringify({ active: true }))).toBeNull()
    // An older draft without its owner is nobody's.
    expect(parsePreview(JSON.stringify({ ...preview, ownerId: undefined }))).toBeNull()
    expect(
      parsePreview(
        serializePreview({ ...preview, form: { ...preview.form, side: 'middle' } } as never)
      )
    ).toBeNull()
  })

  it('shows only to the admin who started it', () => {
    expect(previewOwnedBy(preview, admin)).toBe(true)
    expect(previewOwnedBy(preview, { id: 'admin-2', role: 'admin' })).toBe(false)
    expect(previewOwnedBy(preview, { id: 'user-1', role: 'user' })).toBe(false)
    // The same account after losing the admin role.
    expect(previewOwnedBy(preview, { id: admin.id, role: 'user' })).toBe(false)
    expect(previewOwnedBy(preview, undefined)).toBe(false)
    expect(previewOwnedBy(null, admin)).toBe(false)
  })

  it('belongs to the editor of its admin and announcement only', () => {
    expect(isPreviewFor(preview, id(3), admin)).toBe(true)
    expect(isPreviewFor(preview, null, admin)).toBe(false)
    expect(isPreviewFor({ ...preview, announcementId: null }, null, admin)).toBe(true)
    expect(isPreviewFor(preview, id(3), { id: 'admin-2', role: 'admin' })).toBe(false)
    expect(isPreviewFor(null, null, admin)).toBe(false)
  })
})

describe('acknowledgement retries', () => {
  it('retries network and server failures a few times', () => {
    const offline = new TypeError('Failed to fetch')
    const failing = new ApiRequestError(503, null)
    for (let count = 0; count < SEEN_RETRIES; count++) {
      expect(retrySeen(count, offline)).toBe(true)
      expect(retrySeen(count, failing)).toBe(true)
    }
    expect(retrySeen(SEEN_RETRIES, offline)).toBe(false)
  })

  it('does not retry what the server refused', () => {
    expect(retrySeen(0, new ApiRequestError(404, null))).toBe(false)
    expect(retrySeen(0, new ApiRequestError(401, null))).toBe(false)
  })

  it('backs off between attempts', () => {
    expect([0, 1, 2, 5].map(seenRetryDelay)).toEqual([1000, 2000, 4000, 10_000])
  })

  it('does not retry once another user is signed in', () => {
    expect(retrySeen(0, new SeenByOtherUserError())).toBe(false)
  })
})
