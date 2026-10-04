import { describe, expect, it } from 'vitest'

import {
  assembleFolderTemplates,
  assembleTiles,
  filterLayout,
  freshDashboardIds,
  groupsFromIdToken,
  isCompleteOrder,
  pickPreset,
  rolesFromIdToken,
  tooSmall,
  widgetRefsFromDashboard
} from './logic.js'

describe('isCompleteOrder', () => {
  it('accepts a permutation of every current id', () => {
    expect(isCompleteOrder(['a', 'b', 'c'], ['c', 'a', 'b'])).toBe(true)
  })

  it('rejects missing, unknown, and duplicate ids', () => {
    expect(isCompleteOrder(['a', 'b'], ['a'])).toBe(false)
    expect(isCompleteOrder(['a', 'b'], ['a', 'c'])).toBe(false)
    expect(isCompleteOrder(['a', 'b'], ['a', 'a'])).toBe(false)
  })
})

describe('assembleTiles', () => {
  const geometry = { x: 0, y: 0, w: 2, h: 2 }
  const rows = [
    {
      id: 'a',
      kind: 'widget',
      componentId: 'on',
      widgetKey: 'launcher',
      title: null,
      url: null,
      icon: null,
      ...geometry
    },
    {
      id: 'b',
      kind: 'widget',
      componentId: 'off',
      widgetKey: 'launcher',
      title: null,
      url: null,
      icon: null,
      ...geometry
    },
    {
      id: 'f',
      kind: 'folder',
      componentId: null,
      widgetKey: null,
      title: 'Studium',
      url: null,
      icon: null,
      ...geometry
    },
    {
      id: 'l',
      kind: 'link',
      componentId: null,
      widgetKey: null,
      title: 'Bibliothek',
      url: 'https://example.com/library',
      icon: 'library',
      ...geometry
    },
    {
      id: 'r',
      kind: 'feed',
      componentId: null,
      widgetKey: null,
      title: null,
      url: 'https://example.com/feed.xml',
      icon: null,
      ...geometry
    }
  ]
  const items = [
    {
      id: 'hidden',
      tileId: 'f',
      kind: 'widget',
      componentId: 'off',
      widgetKey: 'launcher',
      title: null,
      url: null,
      icon: null
    },
    {
      id: 'visible',
      tileId: 'f',
      kind: 'widget',
      componentId: 'on',
      widgetKey: 'launcher',
      title: null,
      url: null,
      icon: null
    },
    {
      id: 'personal',
      tileId: 'f',
      kind: 'link',
      componentId: null,
      widgetKey: null,
      title: 'Mensa',
      url: 'https://example.com/mensa',
      icon: null
    }
  ]

  it('filters widgets of disabled components but keeps personal links and feeds', () => {
    expect(assembleTiles(rows, items, new Set(['on:launcher']))).toEqual([
      { kind: 'widget', id: 'a', componentId: 'on', widgetKey: 'launcher', ...geometry },
      {
        kind: 'folder',
        id: 'f',
        title: 'Studium',
        icon: null,
        items: [
          { kind: 'widget', componentId: 'on', widgetKey: 'launcher' },
          {
            kind: 'link',
            id: 'personal',
            title: 'Mensa',
            url: 'https://example.com/mensa',
            icon: null
          }
        ],
        ...geometry
      },
      {
        kind: 'link',
        id: 'l',
        title: 'Bibliothek',
        url: 'https://example.com/library',
        icon: 'library',
        ...geometry
      },
      {
        kind: 'feed',
        id: 'r',
        title: null,
        feedUrl: 'https://example.com/feed.xml',
        ...geometry
      }
    ])
  })
})

describe('layout helpers', () => {
  const dashboard = {
    tiles: [
      {
        id: '00000000-0000-4000-8000-000000000001',
        kind: 'widget' as const,
        componentId: '00000000-0000-4000-8000-000000000010',
        widgetKey: 'launcher',
        x: 0,
        y: 0,
        w: 2,
        h: 2
      },
      {
        id: '00000000-0000-4000-8000-000000000002',
        kind: 'folder' as const,
        title: 'Links',
        icon: null,
        items: [
          {
            kind: 'widget' as const,
            componentId: '00000000-0000-4000-8000-000000000011',
            widgetKey: 'feed'
          },
          {
            kind: 'link' as const,
            id: '00000000-0000-4000-8000-000000000003',
            title: 'JLU',
            url: 'https://www.uni-giessen.de',
            icon: null
          }
        ],
        x: 2,
        y: 0,
        w: 2,
        h: 2
      }
    ]
  }

  it('collects widget references and filters disabled components', () => {
    expect(widgetRefsFromDashboard(dashboard)).toHaveLength(2)
    expect(
      filterLayout(
        { componentIds: ['enabled', 'disabled'] },
        dashboard,
        new Set(['enabled']),
        new Set()
      )
    ).toMatchObject({
      sidebar: { componentIds: ['enabled'] },
      dashboard: { tiles: [{ kind: 'folder', items: [{ kind: 'link' }] }] }
    })
  })

  it('assigns fresh tile and folder-link ids', () => {
    let next = 100
    const copied = freshDashboardIds(dashboard, () => `00000000-0000-4000-8000-000000000${next++}`)
    expect(copied.tiles.map(({ id }) => id)).toEqual([
      '00000000-0000-4000-8000-000000000100',
      '00000000-0000-4000-8000-000000000101'
    ])
    expect(copied.tiles[1]).toMatchObject({
      items: [{ kind: 'widget' }, { kind: 'link', id: '00000000-0000-4000-8000-000000000102' }]
    })
  })
})

describe('assembleFolderTemplates', () => {
  const rows = [
    {
      id: 'study',
      name: 'Studium',
      icon: 'graduation-cap',
      enabled: true,
      sortOrder: 0,
      createdAt: '2026-09-28T12:00:00.000Z',
      updatedAt: '2026-09-28T12:00:00.000Z'
    }
  ]
  const items = [
    { templateId: 'study', componentId: 'enabled', widgetKey: 'launcher' },
    { templateId: 'study', componentId: 'disabled', widgetKey: 'feed' }
  ]

  it('keeps all items for admins and filters widgets of disabled components for users', () => {
    expect(assembleFolderTemplates(rows, items)).toMatchObject([
      {
        id: 'study',
        widgets: [
          { componentId: 'enabled', widgetKey: 'launcher' },
          { componentId: 'disabled', widgetKey: 'feed' }
        ]
      }
    ])
    expect(assembleFolderTemplates(rows, items, new Set(['enabled:launcher']))).toMatchObject([
      { id: 'study', widgets: [{ componentId: 'enabled', widgetKey: 'launcher' }] }
    ])
  })
})

describe('rolesFromIdToken', () => {
  const token = (claims: object): string =>
    ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.')

  it('reads the flat roles claim', () => {
    expect(rolesFromIdToken(token({ roles: ['admin', 'user'] }))).toEqual(['admin', 'user'])
  })

  it('falls back to realm_access.roles', () => {
    expect(rolesFromIdToken(token({ realm_access: { roles: ['user'] } }))).toEqual(['user'])
  })

  it('returns nothing for malformed tokens', () => {
    expect(rolesFromIdToken('not-a-jwt')).toEqual([])
    expect(rolesFromIdToken('a.!!!.c')).toEqual([])
  })
})

describe('groupsFromIdToken', () => {
  const token = (claims: object): string =>
    ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.')

  it('reads only strings from the groups claim', () => {
    expect(groupsFromIdToken(token({ groups: ['/Studierende', 1, '/Beschaeftigte'] }))).toEqual([
      '/Studierende',
      '/Beschaeftigte'
    ])
  })

  it('returns nothing for missing or malformed claims', () => {
    expect(groupsFromIdToken(token({ groups: 'Studierende' }))).toEqual([])
    expect(groupsFromIdToken('not-a-jwt')).toEqual([])
  })
})

describe('pickPreset', () => {
  const presets = [
    { id: 'everyone', audienceKind: 'everyone', audienceName: null, sortOrder: 0 },
    { id: 'student', audienceKind: 'group', audienceName: '/Studierende', sortOrder: 2 },
    { id: 'admin', audienceKind: 'role', audienceName: 'admin', sortOrder: 1 }
  ]

  it('uses priority order across matching roles and groups', () => {
    expect(pickPreset(presets, ['admin'], ['/Studierende'])?.id).toBe('admin')
  })

  it('tries everyone last regardless of its sort order', () => {
    expect(pickPreset(presets, [], ['/Studierende'])?.id).toBe('student')
    expect(pickPreset(presets, [], [])?.id).toBe('everyone')
  })

  it('returns nothing when no audience matches and there is no fallback', () => {
    expect(pickPreset(presets.slice(1), [], [])).toBeUndefined()
  })
})

describe('tooSmall', () => {
  it('names the axes below the minimum', () => {
    expect(tooSmall({ w: 4, h: 6 }, { minW: 2, minH: 2 })).toEqual([])
    expect(tooSmall({ w: 2, h: 2 }, { minW: 4, minH: 3 })).toEqual(['w', 'h'])
    expect(tooSmall({ w: 4, h: 2 }, { minW: 4, minH: 3 })).toEqual(['h'])
  })
})
