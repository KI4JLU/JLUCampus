import { describe, expect, it } from 'vitest'
import {
  dashboardPutSchema,
  TILE_DEFAULT_H,
  TILE_DEFAULT_W,
  TRANSCRIPTION_DEFAULT_CONFIG,
  widgetRefKey,
  type Component,
  type DashboardTile,
  type FolderTile,
  type LinkTile,
  type WidgetRef
} from '@justcampus/shared'
import {
  appendFeedTile,
  appendFolder,
  appendLinkTile,
  appendTile,
  canEnterFolder,
  dropIntoFolder,
  fitTiles,
  folderFromTemplate,
  knownTiles,
  moveOutOfFolder,
  sameTiles
} from './dashboard'
import type { ComponentWidget } from './widgets'

const IFRAME: WidgetRef = {
  componentId: '00000000-0000-4000-8000-000000000001',
  widgetKey: 'launcher'
}
const SHORTCUT: WidgetRef = {
  componentId: '00000000-0000-4000-8000-000000000002',
  widgetKey: 'shortcut'
}
const GONE: WidgetRef = {
  componentId: '00000000-0000-4000-8000-000000000003',
  widgetKey: 'launcher'
}

function component(id: string, type: Component['type']): Component {
  const base = {
    id,
    name: id,
    icon: null,
    iconUrl: null,
    enabled: true,
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
  switch (type) {
    case 'rss':
      return { ...base, type, config: { feedUrl: 'https://example.org/feed' } }
    case 'translator':
      return {
        ...base,
        type,
        config: {
          defaultTargetLanguage: 'en-gb',
          deeplApiUrl: null,
          llmBaseUrl: null,
          llmModels: [],
          llmProviderName: null,
          defaultEngine: null,
          documentsEnabled: false
        }
      }
    case 'transcription':
      return { ...base, type, config: TRANSCRIPTION_DEFAULT_CONFIG }
    case 'iframe':
    case 'link':
      return { ...base, type, config: { url: 'https://example.org' } }
    case 'files':
      return { ...base, type, config: {} }
  }
}

/** Minimums come from the API's widget list; tests may use larger ones than the definitions. */
function widget(ref: WidgetRef, type: Component['type'], minW = 2, minH = 2): ComponentWidget {
  return { ...ref, minW, minH, component: component(ref.componentId, type) }
}

const widgets = new Map<string, ComponentWidget>([
  [widgetRefKey(IFRAME), widget(IFRAME, 'iframe', 5, 7)],
  [widgetRefKey(SHORTCUT), widget(SHORTCUT, 'link')]
])

const folder: FolderTile = {
  kind: 'folder',
  id: '10000000-0000-4000-8000-000000000001',
  title: 'Folder',
  items: [],
  x: 0,
  y: 0,
  w: 4,
  h: 6
}

const link: LinkTile = {
  kind: 'link',
  id: '10000000-0000-4000-8000-000000000002',
  title: 'JLU',
  url: 'https://www.uni-giessen.de',
  icon: null,
  x: 4,
  y: 0,
  w: 2,
  h: 2
}

const widgetTile: DashboardTile = {
  kind: 'widget',
  id: '10000000-0000-4000-8000-000000000003',
  ...IFRAME,
  x: 6,
  y: 0,
  w: 5,
  h: 7
}

/** Every result must still be something the API accepts. */
function expectValid(tiles: DashboardTile[]): void {
  expect(dashboardPutSchema.safeParse({ tiles }).success).toBe(true)
}

describe('append', () => {
  it('adds shortcuts at 2 × 2 and feeds at the default size below everything', () => {
    const withLink = appendLinkTile([folder], { title: 'A', url: 'https://a.example', icon: null })
    const withFeed = appendFeedTile(withLink, { title: null, feedUrl: 'https://a.example/rss' })
    const [, shortcut, feed] = withFeed
    expect(shortcut).toMatchObject({ kind: 'link', x: 0, y: 6, w: 2, h: 2 })
    expect(feed).toMatchObject({ kind: 'feed', x: 0, y: 8, w: TILE_DEFAULT_W, h: TILE_DEFAULT_H })
    expectValid(withFeed)
  })

  it('starts shortcut widgets small and other widgets at the default or their minimum', () => {
    const [shortcut] = appendTile([], widgets.get(widgetRefKey(SHORTCUT))!)
    const [iframe] = appendTile([], widgets.get(widgetRefKey(IFRAME))!)
    expect(shortcut).toMatchObject({ w: 2, h: 2 })
    expect(iframe).toMatchObject({ w: 5, h: 7 })
  })

  it('copies a folder template into a default-sized folder with the known widgets in order', () => {
    const template = {
      name: 'Studium',
      icon: 'graduation-cap',
      widgets: [SHORTCUT, GONE, IFRAME]
    }
    const tiles = appendFolder([link], folderFromTemplate(template, widgets))
    expect(tiles[1]).toMatchObject({
      kind: 'folder',
      title: 'Studium',
      icon: 'graduation-cap',
      items: [
        { kind: 'widget', ...SHORTCUT },
        { kind: 'widget', ...IFRAME }
      ],
      x: 0,
      y: 2,
      w: TILE_DEFAULT_W,
      h: TILE_DEFAULT_H
    })
    expectValid(tiles)
  })
})

describe('knownTiles', () => {
  it('drops tiles and folder entries of unknown widgets, keeps shortcuts and feeds', () => {
    const feed: DashboardTile = {
      kind: 'feed',
      id: '10000000-0000-4000-8000-000000000004',
      title: null,
      feedUrl: 'https://example.org/feed',
      x: 0,
      y: 6,
      w: 4,
      h: 6
    }
    const shortcutItem = {
      kind: 'link',
      id: link.id,
      title: 'A',
      url: link.url,
      icon: null
    } as const
    const full: FolderTile = {
      ...folder,
      items: [{ kind: 'widget', ...GONE }, { kind: 'widget', ...IFRAME }, shortcutItem]
    }
    const gone: DashboardTile = { ...widgetTile, ...GONE }
    const result = knownTiles([full, link, feed, gone, widgetTile], widgets)
    expect(result.map((tile) => tile.id)).toEqual([folder.id, link.id, feed.id, widgetTile.id])
    expect((result[0] as FolderTile).items).toEqual([{ kind: 'widget', ...IFRAME }, shortcutItem])
  })

  it('returns untouched folders as the same object', () => {
    const tiles = [{ ...folder, items: [{ kind: 'widget' as const, ...IFRAME }] }]
    expect(knownTiles(tiles, widgets)[0]).toBe(tiles[0])
  })
})

describe('fitTiles', () => {
  it('grows feed tiles to their minimum and widget tiles to their widget minimum', () => {
    const feed: DashboardTile = {
      kind: 'feed',
      id: '10000000-0000-4000-8000-000000000004',
      title: null,
      feedUrl: 'https://example.org/feed',
      x: 0,
      y: 0,
      w: 2,
      h: 2
    }
    const [grownFeed, grownWidget, keptLink] = fitTiles(
      [feed, { ...widgetTile, w: 2, h: 2 }, link],
      widgets
    )
    expect(grownFeed).toMatchObject({ w: 3, h: 3 })
    expect(grownWidget).toMatchObject({ w: 5, h: 7 })
    expect(keptLink).toBe(link)
  })
})

describe('sameTiles', () => {
  it('notices a changed shortcut, feed title, folder icon or folder item', () => {
    expect(sameTiles([link], [{ ...link }])).toBe(true)
    expect(sameTiles([link], [{ ...link, icon: 'house' }])).toBe(false)
    const item = { kind: 'link', id: link.id, title: 'A', url: link.url, icon: null } as const
    const withItem = { ...folder, items: [item] }
    expect(sameTiles([withItem], [{ ...withItem, items: [{ ...item, title: 'B' }] }])).toBe(false)
    expect(sameTiles([folder], [{ ...folder, icon: 'house' }])).toBe(false)
  })
})

describe('dropIntoFolder', () => {
  it('turns a shortcut tile into a folder entry and removes the tile', () => {
    const result = dropIntoFolder([folder, link], widgets, link.id, folder.id)
    expect(result).toHaveLength(1)
    expect((result[0] as FolderTile).items).toEqual([
      { kind: 'link', id: link.id, title: link.title, url: link.url, icon: null }
    ])
    expectValid(result)
  })

  it('adds a widget once, even when a second tile of it is dropped', () => {
    const inside = { ...folder, items: [{ kind: 'widget' as const, ...IFRAME }] }
    const result = dropIntoFolder([inside, widgetTile], widgets, widgetTile.id, folder.id)
    expect(result).toHaveLength(1)
    expect((result[0] as FolderTile).items).toHaveLength(1)
  })

  it('leaves feed and folder tiles on the grid', () => {
    const feed = appendFeedTile([], { title: null, feedUrl: 'https://a.example/rss' })[0]!
    expect(canEnterFolder(feed)).toBe(false)
    expect(canEnterFolder(folder)).toBe(false)
    expect(canEnterFolder(link)).toBe(true)
    const tiles = [folder, feed]
    expect(dropIntoFolder(tiles, widgets, feed.id, folder.id)).toBe(tiles)
  })
})

describe('moveOutOfFolder', () => {
  const shortcut = { kind: 'link', id: link.id, title: 'A', url: link.url, icon: 'house' } as const
  const widgetItem = { kind: 'widget', ...IFRAME } as const
  const full: FolderTile = { ...folder, items: [widgetItem, shortcut] }

  it('turns a shortcut into a 2 × 2 link tile with a fresh id at the cell', () => {
    const result = moveOutOfFolder([full], widgets, folder.id, shortcut, {
      kind: 'cell',
      x: 8,
      y: 0
    })
    expect((result[0] as FolderTile).items).toEqual([widgetItem])
    const tile = result[1]!
    expect(tile).toMatchObject({
      kind: 'link',
      title: 'A',
      url: link.url,
      icon: 'house',
      x: 8,
      y: 0,
      w: 2,
      h: 2
    })
    expect(tile.id).not.toBe(link.id)
    expectValid(result)
  })

  it('turns a widget into a widget tile sized for the widget', () => {
    const result = moveOutOfFolder([full], widgets, folder.id, widgetItem, {
      kind: 'cell',
      x: 11,
      y: 0
    })
    expect(result[1]).toMatchObject({ kind: 'widget', ...IFRAME, x: 7, w: 5, h: 7 })
    expectValid(result)
  })

  it('moves a shortcut into another folder, keeping it once', () => {
    const other: FolderTile = { ...folder, id: '10000000-0000-4000-8000-000000000009', x: 4 }
    const result = moveOutOfFolder([full, other], widgets, folder.id, shortcut, {
      kind: 'folder',
      folderId: other.id
    })
    expect((result[0] as FolderTile).items).toEqual([widgetItem])
    expect((result[1] as FolderTile).items).toEqual([shortcut])
    expectValid(result)
  })

  it('does nothing when dropped back onto its own folder', () => {
    const tiles = [full]
    const target = { kind: 'folder', folderId: folder.id } as const
    expect(moveOutOfFolder(tiles, widgets, folder.id, shortcut, target)).toBe(tiles)
  })
})
