import { describe, expect, it } from 'vitest'
import {
  TRANSCRIPTION_BUILTIN_TEMPLATES,
  type TranscriptionTemplate,
  type TranscriptionTemplateBlock
} from '@justcampus/shared'
import {
  fillPlaceholders,
  insertToken,
  PLACEHOLDERS,
  placeholderToken,
  placeholderValues,
  SAMPLE_PARTICIPANTS,
  SAMPLE_TITLE
} from './placeholders'
import {
  cacheScope,
  clearPreviewCaches,
  PREVIEW_CACHE_KEY,
  previewCacheKey,
  readPreviewCache,
  sectionPreview,
  staleSections,
  stringHash,
  userCachePrefix,
  withPreviewResults,
  writePreviewCache,
  type PreviewStorage
} from './preview-cache'
import {
  activeTemplate,
  DEFAULT_SUMMARY_TEMPLATE_ID,
  templateActions,
  templateStore
} from './store'
import {
  matchesTemplateSearch,
  moveBlock,
  moveBlockTo,
  newTemplateDraft,
  removeBlock,
  templateDraft,
  templateSubtext,
  toEditorBlocks,
  toStructure,
  updateBlock
} from './structure'

/** The five built-ins as the server lists them. */
const BUILT_INS: TranscriptionTemplate[] = TRANSCRIPTION_BUILTIN_TEMPLATES.map((template) => ({
  ...template,
  structure: template.structure as unknown as TranscriptionTemplateBlock[],
  builtIn: true,
  version: 1,
  outputFormatHints: null,
  createdAt: null,
  updatedAt: null
}))
const builtIn = (id: string): TranscriptionTemplate => BUILT_INS.find((item) => item.id === id)!

/** `localStorage` in memory. */
function memoryStorage(): PreviewStorage & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    get length() {
      return map.size
    },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key)
  }
}

describe('placeholders', () => {
  it('inserts the English tokens at the cursor, replacing the selection', () => {
    expect(PLACEHOLDERS.map(placeholderToken)).toEqual([
      '{{title}}',
      '{{date}}',
      '{{participants}}',
      '{{duration}}'
    ])
    expect(insertToken('Datum: ', 7, 7, '{{date}}')).toEqual({
      value: 'Datum: {{date}}',
      cursor: 15
    })
    expect(insertToken('A XX B', 2, 4, '{{title}}')).toEqual({ value: 'A {{title}} B', cursor: 11 })
    expect(insertToken('Ende', null, null, '{{dauer}}')).toEqual({
      value: 'Ende{{dauer}}',
      cursor: 13
    })
  })

  it('fills the transcript facts, aliases included, and none stays literal', () => {
    const values = placeholderValues(
      {
        title: 'Transcript 1',
        createdAt: '2026-10-04T10:00:00.000Z',
        segments: [{ speaker: 'Anna' }, { speaker: null }, { speaker: 'Ben' }, { speaker: 'Anna' }],
        duration: 1800
      },
      'de',
      (minutes) => `${minutes} Min`
    )
    expect(values).toEqual({
      title: 'Transcript 1',
      date: '4.10.2026',
      participants: 'Anna, Ben',
      duration: '30 Min'
    })
    const filled = fillPlaceholders(
      '{{title}} {{titel}} · {{date}} {{datum}} · {{participants}} {{teilnehmer}} · {{duration}} {{dauer}}',
      values
    )
    expect(filled).toBe(
      'Transcript 1 Transcript 1 · 4.10.2026 4.10.2026 · Anna, Ben Anna, Ben · 30 Min 30 Min'
    )
    expect(filled).not.toMatch(/\{\{/)
  })

  it("falls back to kiChat's sample values", () => {
    const values = placeholderValues(
      { title: null, createdAt: null, segments: [], duration: null },
      'en',
      (minutes) => `${minutes} min`,
      new Date('2026-10-04T12:00:00')
    )
    expect(values.title).toBe(SAMPLE_TITLE)
    expect(values.participants).toBe(SAMPLE_PARTICIPANTS)
    expect(values.duration).toBe('45 min')
  })
})

describe('preview cache', () => {
  const section = { heading: 'Zusammenfassung', instruction: 'Fasse zusammen.' }

  it("hashes like kiChat's getStringHash", () => {
    expect(stringHash('')).toBe('0')
    expect(stringHash('a')).toBe('97')
    expect(stringHash('ab')).toBe('3105')
    expect(stringHash('x'.repeat(100))).toMatch(/^-?\d+$/)
  })

  it('scopes stores by user and module', () => {
    expect(previewCacheKey('u1', 'c1')).toBe(`${PREVIEW_CACHE_KEY}:u1:c1`)
    expect(previewCacheKey('u1', 'c1').startsWith(userCachePrefix('u1'))).toBe(true)
    expect(cacheScope(null, ' ')).toEqual(['preview-default', 'default'])
  })

  it('marks a section empty, fresh, then stale when its instruction changes', () => {
    let cache = {}
    expect(sectionPreview(cache, 't', 'Vorlage', section).status).toBe('empty')
    cache = withPreviewResults(cache, 't', 'Vorlage', [{ id: 's1', ...section }], {
      s1: 'Ergebnis',
      other: 'nicht gefragt'
    })
    expect(sectionPreview(cache, 't', 'Vorlage', section)).toEqual({
      status: 'fresh',
      output: 'Ergebnis'
    })
    const changed = { ...section, instruction: 'Fasse kurz zusammen.' }
    expect(sectionPreview(cache, 't', 'Vorlage', changed)).toEqual({
      status: 'stale',
      output: 'Ergebnis'
    })
    expect(staleSections(cache, 't', 'Vorlage', [section, changed])).toEqual([changed])
    // Another transcript or template name has its own previews.
    expect(sectionPreview(cache, 'u', 'Vorlage', section).status).toBe('empty')
    expect(sectionPreview(cache, 't', 'Andere', section).status).toBe('empty')
  })

  it('fills only the sections asked for', () => {
    const cache = withPreviewResults({}, 't', 'V', [{ id: 'a', heading: 'A', instruction: 'x' }], {
      a: 'A!',
      b: 'B!'
    })
    expect(Object.keys(cache.t!.V!)).toEqual(['A'])
  })

  it('stores, reads and clears per user', () => {
    const storage = memoryStorage()
    const mine = previewCacheKey('u1', 'c1')
    const cache = withPreviewResults({}, 't', 'V', [{ id: 'a', ...section }], { a: 'A' })
    writePreviewCache(storage, mine, cache)
    writePreviewCache(storage, previewCacheKey('u2', 'c1'), cache)
    storage.setItem(PREVIEW_CACHE_KEY, '{}')
    storage.setItem('other', 'kept')
    expect(readPreviewCache(storage, mine)).toEqual(cache)
    clearPreviewCaches(storage, userCachePrefix('u1'))
    expect([...storage.map.keys()].sort()).toEqual([mine, 'other'].sort())
    clearPreviewCaches(storage)
    expect([...storage.map.keys()]).toEqual(['other'])
    storage.setItem(mine, 'not json')
    expect(readPreviewCache(storage, mine)).toEqual({})
  })
})

describe('template structure', () => {
  const blocks = toEditorBlocks([
    { type: 'heading', level: 1, text: 'A' },
    { type: 'text', text: 'B' },
    { type: 'divider' },
    { type: 'section', id: 'kept', heading: 'C', instruction: 'c' }
  ])

  it('moves, drags, changes and deletes blocks', () => {
    const order = (items: typeof blocks): string[] =>
      items.map((block) =>
        block.type === 'divider' ? '-' : 'text' in block ? block.text : block.heading
      )
    expect(order(moveBlock(blocks, 0, 1))).toEqual(['B', 'A', '-', 'C'])
    expect(order(moveBlock(blocks, 0, -1))).toEqual(['A', 'B', '-', 'C'])
    expect(order(moveBlock(blocks, 3, 1))).toEqual(['A', 'B', '-', 'C'])
    expect(order(moveBlockTo(blocks, blocks[3]!.key, blocks[0]!.key))).toEqual(['C', 'A', 'B', '-'])
    expect(order(removeBlock(blocks, blocks[1]!.key))).toEqual(['A', '-', 'C'])
    expect(order(updateBlock(blocks, blocks[0]!.key, { text: 'Neu' }))).toEqual([
      'Neu',
      'B',
      '-',
      'C'
    ])
  })

  it('saves the ordered structure without editor keys; sections keep ids', () => {
    expect(toStructure(blocks)).toEqual([
      { type: 'heading', level: 1, text: 'A' },
      { type: 'text', text: 'B' },
      { type: 'divider' },
      { type: 'section', id: 'kept', heading: 'C', instruction: 'c' }
    ])
  })

  it('opens built-ins as copies with a new id and the user own as they are', () => {
    const copyName = (name: string): string => `${name} (Kopie)`
    const copy = templateDraft(builtIn('interview'), false, copyName)
    expect(copy.id).toBeNull()
    expect(copy.name).toBe('Interview (Kopie)')
    expect(toStructure(copy.blocks).map((block) => block.type)).toEqual([
      'heading',
      'text',
      'section',
      'section',
      'section'
    ])
    const own = { ...builtIn('interview'), id: 'mine', builtIn: false, name: 'Meins' }
    expect(templateDraft(own, false, copyName)).toMatchObject({ id: 'mine', name: 'Meins' })
  })

  it("starts a new template like kiChat's", () => {
    const draft = newTemplateDraft({
      name: 'Meine neue Vorlage',
      sectionHeading: 'Zusammenfassung',
      sectionInstruction: 'Fasse das Gespräch in 3-4 Sätzen zusammen'
    })
    expect(draft.id).toBeNull()
    expect(toStructure(draft.blocks).map(({ type }) => type)).toEqual([
      'heading',
      'text',
      'section'
    ])
  })

  it('describes and finds templates by name and sections', () => {
    expect(templateSubtext(builtIn('meeting-protocol').structure)).toBe(
      'Ergebnisse · Beschlüsse · To-dos'
    )
    expect(templateSubtext(builtIn('legacy').structure)).toBe('')
    expect(matchesTemplateSearch(builtIn('interview'), '  ZITATE ')).toBe(true)
    expect(matchesTemplateSearch(builtIn('interview'), 'fokus')).toBe(false)
    expect(matchesTemplateSearch(builtIn('focus-group'), 'fokus')).toBe(true)
  })
})

describe('active template', () => {
  it("prefers the picked one, then the transcript's, then kiChat's default", () => {
    expect(activeTemplate(BUILT_INS, 'interview', 'legacy')?.id).toBe('interview')
    expect(activeTemplate(BUILT_INS, null, 'legacy')?.id).toBe('legacy')
    expect(activeTemplate(BUILT_INS, null, null)?.id).toBe(DEFAULT_SUMMARY_TEMPLATE_ID)
    expect(activeTemplate(BUILT_INS, 'deleted', null)?.id).toBe(DEFAULT_SUMMARY_TEMPLATE_ID)
    expect(activeTemplate([], 'interview', null)).toBeNull()
  })

  it('forgets a deleted pick', () => {
    templateActions.select('mine')
    templateActions.deleted('other')
    expect(templateStore.get().selectedId).toBe('mine')
    templateActions.deleted('mine')
    expect(templateStore.get().selectedId).toBeNull()
  })
})
