import { describe, expect, it } from 'vitest'
import { activeAdminEntry, isAdminPath } from './admin-nav'

const modules = new Set(['translator-id'])

describe('isAdminPath', () => {
  it('holds for the admin area and its pages', () => {
    expect(isAdminPath('/admin')).toBe(true)
    expect(isAdminPath('/admin/components')).toBe(true)
    expect(isAdminPath('/admin/presets/abc')).toBe(true)
  })

  it('does not hold elsewhere', () => {
    expect(isAdminPath('/')).toBe(false)
    expect(isAdminPath('/c/abc')).toBe(false)
    expect(isAdminPath('/administration')).toBe(false)
  })
})

describe('activeAdminEntry', () => {
  it('marks the section of a section page', () => {
    expect(activeAdminEntry('/admin/components', modules)).toEqual({
      kind: 'section',
      section: 'components'
    })
    expect(activeAdminEntry('/admin/folders', modules)).toEqual({
      kind: 'section',
      section: 'folders'
    })
    expect(activeAdminEntry('/admin/users', modules)).toEqual({ kind: 'section', section: 'users' })
  })

  it('keeps announcements current in an announcement editor', () => {
    const announcements = { kind: 'section', section: 'announcements' }
    expect(activeAdminEntry('/admin/announcements', modules)).toEqual(announcements)
    expect(activeAdminEntry('/admin/announcements/new', modules)).toEqual(announcements)
    expect(activeAdminEntry('/admin/announcements/abc', modules)).toEqual(announcements)
  })

  it('keeps layout presets current in a preset editor', () => {
    expect(activeAdminEntry('/admin/presets/abc', modules)).toEqual({
      kind: 'section',
      section: 'presets'
    })
  })

  it('marks a module on its own form', () => {
    expect(activeAdminEntry('/admin/components/translator-id', modules)).toEqual({
      kind: 'module',
      id: 'translator-id'
    })
  })

  it('keeps components current on the form of a new or an ordinary component', () => {
    const components = { kind: 'section', section: 'components' }
    expect(activeAdminEntry('/admin/components/new', modules)).toEqual(components)
    expect(activeAdminEntry('/admin/components/other-id', modules)).toEqual(components)
    // Before the modules are known, a module's form counts as a component's.
    expect(activeAdminEntry('/admin/components/translator-id', new Set())).toEqual(components)
  })

  it('marks nothing outside the sections', () => {
    expect(activeAdminEntry('/admin', modules)).toBeNull()
    expect(activeAdminEntry('/admin/unknown', modules)).toBeNull()
    expect(activeAdminEntry('/c/translator-id', modules)).toBeNull()
  })
})
