import { describe, expect, it } from 'vitest'
import type { TFunction } from 'i18next'
import type { AdminAnnouncement } from '@justcampus/shared'
import { ApiRequestError } from './api'
import {
  initialAnnouncementForm,
  isAnnouncementFormDirty,
  selectorProblem,
  serverAnnouncementErrors,
  validateAnnouncementForm,
  type AnnouncementFormState
} from './announcement-form'

// Messages come back as their keys, so the tests see which one was chosen.
const t = ((key: string) => key) as unknown as TFunction

/** Stands in for `document.querySelector`: rejects what a browser would reject here. */
const query = (selector: string): null => {
  if (/^[>+~]|\[$|^\d/.test(selector)) throw new SyntaxError(`'${selector}' is not valid`)
  return null
}

const hint: AdminAnnouncement = {
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'hint',
  enabled: true,
  texts: {
    de: { title: 'Mehr Apps', body: 'Hier finden Sie weitere Apps.' },
    en: { title: 'More apps', body: 'Find more apps here.' }
  },
  target: { selector: '[data-tour="more-apps"]', path: null },
  publishedAt: '2026-10-01T00:00:00.000Z',
  seenCount: 3,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z'
}

const filled: AnnouncementFormState = {
  ...initialAnnouncementForm(null),
  texts: {
    de: { title: 'Neu', body: 'Erster Absatz.\n\nZweiter Absatz.' },
    en: { title: 'New', body: 'First paragraph.\n\nSecond paragraph.' }
  }
}

describe('initialAnnouncementForm', () => {
  it('starts a new announcement as a disabled news item', () => {
    const state = initialAnnouncementForm(null)
    expect(state.kind).toBe('news')
    expect(state.enabled).toBe(false)
  })

  it('takes a hint with every-page target as an empty path', () => {
    const state = initialAnnouncementForm(hint)
    expect(state).toMatchObject({ kind: 'hint', selector: hint.target?.selector, path: '' })
  })
})

describe('isAnnouncementFormDirty', () => {
  it('notices an edit and forgets it once undone', () => {
    const baseline = initialAnnouncementForm(hint)
    const edited = { ...baseline, texts: { ...baseline.texts, de: { title: 'X', body: 'Y' } } }
    expect(isAnnouncementFormDirty(edited, baseline)).toBe(true)
    expect(isAnnouncementFormDirty(initialAnnouncementForm(hint), baseline)).toBe(false)
  })
})

describe('selectorProblem', () => {
  it('flags what the browser cannot parse', () => {
    expect(selectorProblem('> div', query)).toBe('invalid')
  })

  it('accepts valid and still empty selectors', () => {
    expect(selectorProblem('[data-tour="more-apps"]', query)).toBeNull()
    expect(selectorProblem('  ', query)).toBeNull()
  })
})

describe('validateAnnouncementForm', () => {
  it('sends news without a target', () => {
    const result = validateAnnouncementForm({ ...filled, selector: 'stale' }, t, query)
    expect(result).toEqual({
      ok: true,
      input: { kind: 'news', enabled: false, texts: filled.texts, target: null }
    })
  })

  it('sends a hint with its target, an empty path as every page', () => {
    const state = {
      ...filled,
      kind: 'hint' as const,
      selector: ' #a ',
      path: ' '
    }
    const result = validateAnnouncementForm(state, t, query)
    expect(result.ok && result.input.target).toEqual({ selector: '#a', path: null })
  })

  it('requires both languages', () => {
    const state = { ...filled, texts: { ...filled.texts, en: { title: ' ', body: '' } } }
    const result = validateAnnouncementForm(state, t, query)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors['texts.en.title']).toBe('admin.announcements.form.errors.title')
    expect(result.errors['texts.en.body']).toBe('admin.announcements.form.errors.body')
    expect(result.errors['texts.de.title']).toBeUndefined()
  })

  it('checks the target of a hint', () => {
    const missing = validateAnnouncementForm({ ...filled, kind: 'hint' }, t, query)
    expect(!missing.ok && missing.errors['target.selector']).toBe(
      'admin.announcements.form.errors.selector'
    )
    const invalid = validateAnnouncementForm({ ...filled, kind: 'hint', selector: '> a' }, t, query)
    expect(!invalid.ok && invalid.errors['target.selector']).toBe(
      'admin.announcements.form.errors.selectorInvalid'
    )
    const path = validateAnnouncementForm(
      { ...filled, kind: 'hint', selector: '#a', path: 'c/*' },
      t,
      query
    )
    expect(!path.ok && path.errors['target.path']).toBe('admin.announcements.form.errors.path')
  })
})

describe('serverAnnouncementErrors', () => {
  it('maps the server issues onto the fields', () => {
    const error = new ApiRequestError(400, {
      error: {
        code: 'validation',
        message: 'Invalid',
        issues: [{ path: ['target', 'path'], message: 'bad' }]
      }
    })
    expect(serverAnnouncementErrors(error, t)).toEqual({
      'target.path': 'admin.announcements.form.errors.path'
    })
  })

  it('leaves other errors to the form banner', () => {
    expect(serverAnnouncementErrors(new ApiRequestError(500, null), t)).toBeNull()
    expect(serverAnnouncementErrors(new Error('offline'), t)).toBeNull()
  })
})
