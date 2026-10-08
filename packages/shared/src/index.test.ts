import { describe, expect, it } from 'vitest'
import {
  adminComponentSchema,
  COMPONENT_SECRETS,
  COMPONENT_TYPES,
  componentSchema,
  dashboardPutSchema,
  desktopLinkFor,
  desktopLinkPath,
  isSingletonType,
  SINGLETON_COMPONENT_TYPES,
  translateRequestSchema,
  translatorComponentConfigSchema,
  translatorEngineIdSchema,
  rephraseRequestSchema,
  parseGlossaryCsv,
  translatorGlossaryEntrySchema,
  translatorGlossaryInputSchema,
  translatorGlossaryPatchSchema,
  toTranslatorLanguage,
  TRANSLATE_TEXT_MAX,
  TRANSLATOR_GLOSSARY_TOO_LONG,
  translatorDocumentExtension,
  translatorDocumentUploadSchema,
  externalUrlSchema,
  feedSchema,
  folderTemplateInputSchema,
  folderTileSchema,
  componentInputSchema,
  componentName,
  httpsUrlSchema,
  widgetDefinition
} from './index'

describe('httpsUrlSchema', () => {
  it('accepts https and loopback http', () => {
    expect(httpsUrlSchema.safeParse('https://studip.uni-giessen.de').success).toBe(true)
    expect(httpsUrlSchema.safeParse('http://localhost:8000/x').success).toBe(true)
  })

  it('rejects plain http and garbage without throwing', () => {
    expect(httpsUrlSchema.safeParse('http://example.org').success).toBe(false)
    expect(httpsUrlSchema.safeParse('foo').success).toBe(false)
    expect(httpsUrlSchema.safeParse('').success).toBe(false)
  })
})

describe('componentInputSchema', () => {
  it('reports the url path for a bad iframe url', () => {
    const result = componentInputSchema.safeParse({
      type: 'iframe',
      name: 'X',
      icon: null,
      iconUrl: null,
      enabled: true,
      config: { url: 'nope' }
    })
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(['config', 'url'])
  })

  const link = {
    type: 'link',
    name: 'Mensa',
    icon: null,
    iconUrl: null,
    enabled: true,
    config: { url: 'https://example.org' }
  }

  it('takes translated names, trimmed, and none from older clients', () => {
    const translated = componentInputSchema.parse({
      ...link,
      nameTranslations: { en: ' Canteen ' }
    })
    expect(translated.nameTranslations).toEqual({ en: 'Canteen' })
    expect(componentInputSchema.parse(link).nameTranslations).toEqual({})
  })

  it('rejects blank, overlong and unknown-language names', () => {
    for (const nameTranslations of [{ en: ' ' }, { en: 'x'.repeat(81) }, { fr: 'Cantine' }]) {
      expect(componentInputSchema.safeParse({ ...link, nameTranslations }).success).toBe(false)
    }
  })
})

describe('componentName', () => {
  const component = { name: 'Mensa', nameTranslations: { en: 'Canteen' } }

  it('shows the translation, or the name where there is none', () => {
    expect(componentName(component, 'en')).toBe('Canteen')
    expect(componentName(component, 'de')).toBe('Mensa')
  })
})

describe('dashboardPutSchema', () => {
  it('rejects tiles past the right edge and duplicate ids', () => {
    const tile = {
      id: '11111111-1111-4111-8111-111111111111',
      kind: 'widget',
      componentId: '22222222-2222-4222-8222-222222222222',
      widgetKey: 'launcher'
    }
    expect(
      dashboardPutSchema.safeParse({ tiles: [{ ...tile, x: 8, y: 0, w: 6, h: 2 }] }).success
    ).toBe(false)
    expect(
      dashboardPutSchema.safeParse({
        tiles: [
          { ...tile, x: 0, y: 0, w: 2, h: 2 },
          { ...tile, x: 2, y: 0, w: 2, h: 2 }
        ]
      }).success
    ).toBe(false)
  })
})

describe('widgetDefinition', () => {
  it('knows the widgets of each component type', () => {
    expect(widgetDefinition('iframe', 'launcher')).toEqual({ minW: 2, minH: 2 })
    expect(widgetDefinition('rss', 'feed')).toBeDefined()
  })

  it('rejects keys of other types and inherited properties', () => {
    expect(widgetDefinition('iframe', 'feed')).toBeUndefined()
    expect(widgetDefinition('link', 'toString')).toBeUndefined()
  })
})

describe('folder tiles', () => {
  const folder = {
    kind: 'folder' as const,
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Studium',
    x: 0,
    y: 0,
    w: 2,
    h: 2
  }
  const componentId = '22222222-2222-4222-8222-222222222222'

  const widgetItem = { kind: 'widget' as const, componentId, widgetKey: 'launcher' }
  const linkItem = {
    kind: 'link' as const,
    id: '33333333-3333-4333-8333-333333333333',
    title: 'Mensa',
    url: 'http://mensa.example.org',
    icon: null
  }

  it('accepts a folder with unique widgets and rejects duplicates', () => {
    expect(
      dashboardPutSchema.safeParse({ tiles: [{ ...folder, items: [widgetItem] }] }).success
    ).toBe(true)
    expect(
      dashboardPutSchema.safeParse({ tiles: [{ ...folder, items: [widgetItem, widgetItem] }] })
        .success
    ).toBe(false)
    expect(
      dashboardPutSchema.safeParse({ tiles: [{ ...folder, title: '', items: [] }] }).success
    ).toBe(false)
  })

  it('accepts folders with no icon and valid Lucide icons', () => {
    expect(folderTileSchema.safeParse({ ...folder, items: [] }).success).toBe(true)
    expect(
      folderTileSchema.safeParse({ ...folder, icon: 'graduation-cap', items: [] }).success
    ).toBe(true)
  })

  it('holds shortcuts next to widgets, each shortcut once', () => {
    expect(
      dashboardPutSchema.safeParse({ tiles: [{ ...folder, items: [widgetItem, linkItem] }] })
        .success
    ).toBe(true)
    expect(
      dashboardPutSchema.safeParse({ tiles: [{ ...folder, items: [linkItem, linkItem] }] }).success
    ).toBe(false)
  })
})

describe('folderTemplateInputSchema', () => {
  it('rejects duplicate widgets and an empty name', () => {
    const ref = { componentId: '22222222-2222-4222-8222-222222222222', widgetKey: 'launcher' }
    const base = { name: 'Studium', icon: null, enabled: true, widgets: [ref] }
    expect(folderTemplateInputSchema.safeParse(base).success).toBe(true)
    expect(folderTemplateInputSchema.safeParse({ ...base, widgets: [ref, ref] }).success).toBe(
      false
    )
    expect(folderTemplateInputSchema.safeParse({ ...base, name: '   ' }).success).toBe(false)
  })
})

describe('personal tiles', () => {
  const geometry = { id: '11111111-1111-4111-8111-111111111111', x: 0, y: 0, w: 2, h: 2 }

  it('accepts a shortcut to any http(s) URL and nothing else', () => {
    const link = { ...geometry, kind: 'link', title: 'Mensa', icon: null }
    expect(
      dashboardPutSchema.safeParse({ tiles: [{ ...link, url: 'http://mensa.example.org' }] })
        .success
    ).toBe(true)
    expect(
      dashboardPutSchema.safeParse({ tiles: [{ ...link, url: 'javascript:alert(1)' }] }).success
    ).toBe(false)
  })

  it('accepts a feed tile with or without its own title', () => {
    const feed = { ...geometry, kind: 'feed', feedUrl: 'https://www.uni-giessen.de/rss' }
    expect(dashboardPutSchema.safeParse({ tiles: [{ ...feed, title: null }] }).success).toBe(true)
    expect(dashboardPutSchema.safeParse({ tiles: [{ ...feed, title: 'News' }] }).success).toBe(true)
    expect(dashboardPutSchema.safeParse({ tiles: [{ ...feed, title: '' }] }).success).toBe(false)
  })
})

describe('externalUrlSchema', () => {
  it('allows http and https only', () => {
    expect(externalUrlSchema.safeParse('http://example.org').success).toBe(true)
    expect(externalUrlSchema.safeParse('https://example.org/feed.xml').success).toBe(true)
    expect(externalUrlSchema.safeParse('ftp://example.org').success).toBe(false)
    expect(externalUrlSchema.safeParse('data:text/html,x').success).toBe(false)
  })
})

describe('rss and link components', () => {
  const base = { name: 'X', icon: null, iconUrl: null, enabled: true }

  it('validates the feed and link URLs', () => {
    expect(
      componentInputSchema.safeParse({
        ...base,
        type: 'rss',
        config: { feedUrl: 'http://a.de/rss' }
      }).success
    ).toBe(true)
    const bad = componentInputSchema.safeParse({ ...base, type: 'link', config: { url: 'nope' } })
    expect(bad.success).toBe(false)
    if (!bad.success) expect(bad.error.issues[0]?.path).toEqual(['config', 'url'])
  })
})

describe('feedSchema', () => {
  it('rejects unsafe entry links', () => {
    const feed = {
      title: 'News',
      link: null,
      fetchedAt: '2026-09-28T12:00:00.000Z',
      items: [{ id: '1', title: 'A', link: 'javascript:x', publishedAt: null, summary: null }]
    }
    expect(feedSchema.safeParse(feed).success).toBe(false)
  })
})

describe('modules', () => {
  const translator = {
    type: 'translator',
    name: 'Übersetzer',
    icon: 'languages',
    iconUrl: null,
    enabled: true,
    config: { defaultTargetLanguage: 'en-gb' }
  }

  it('lists only known component types as singletons', () => {
    for (const type of SINGLETON_COMPONENT_TYPES) expect(COMPONENT_TYPES).toContain(type)
    expect(isSingletonType('translator')).toBe(true)
    expect(isSingletonType('iframe')).toBe(false)
  })

  it('accepts setting, removing and keeping a secret', () => {
    for (const secrets of [{ deeplApiKey: 'key' }, { deeplApiKey: null }, {}, undefined]) {
      expect(componentInputSchema.safeParse({ ...translator, secrets }).success).toBe(true)
    }
  })

  it('rejects unknown and empty secrets', () => {
    expect(componentInputSchema.safeParse({ ...translator, secrets: { token: 'x' } }).success).toBe(
      false
    )
    expect(
      componentInputSchema.safeParse({ ...translator, secrets: { deeplApiKey: ' ' } }).success
    ).toBe(false)
  })

  it('drops secrets sent for types without secrets', () => {
    expect(COMPONENT_SECRETS.link).toEqual([])
    const result = componentInputSchema.safeParse({
      type: 'link',
      name: 'X',
      icon: null,
      iconUrl: null,
      enabled: true,
      config: { url: 'https://example.org' },
      secrets: { deeplApiKey: 'key' }
    })
    expect(result.success && 'secrets' in result.data).toBe(false)
  })

  it('never lets a secret value into a component as users see it', () => {
    const stored = {
      ...translator,
      id: '00000000-0000-4000-8000-000000000001',
      sortOrder: 0,
      createdAt: '2026-09-29T00:00:00.000Z',
      updatedAt: '2026-09-29T00:00:00.000Z'
    }
    const parsed = componentSchema.parse({ ...stored, secrets: { deeplApiKey: 'v1.secret' } })
    expect('secrets' in parsed).toBe(false)
    expect(
      adminComponentSchema.safeParse({
        ...stored,
        secrets: { deeplApiKey: true, llmApiKey: false }
      }).success
    ).toBe(true)
    expect(
      adminComponentSchema.safeParse({ ...stored, secrets: { deeplApiKey: 'v1.secret' } }).success
    ).toBe(false)
  })

  it('limits translation requests to known languages and a non-empty text', () => {
    expect(
      translateRequestSchema.safeParse({
        text: ['Hallo. ', 'Welt.'],
        source: null,
        target: 'en-gb'
      }).success
    ).toBe(true)
    expect(
      translateRequestSchema.safeParse({ text: [' ', '\n'], source: null, target: 'en-gb' }).success
    ).toBe(false)
    expect(
      translateRequestSchema.safeParse({ text: ['Hallo'], source: 'de', target: 'en' }).success
    ).toBe(false)
  })

  it('takes texts up to TRANSLATE_TEXT_MAX characters in all', () => {
    const half = 'a'.repeat(TRANSLATE_TEXT_MAX / 2)
    const request = { source: null, target: 'de' }
    expect(translateRequestSchema.safeParse({ ...request, text: [half, half] }).success).toBe(true)
    expect(translateRequestSchema.safeParse({ ...request, text: [half, half, 'a'] }).success).toBe(
      false
    )
  })

  it('reads language codes as the translator offers them', () => {
    expect(toTranslatorLanguage('EN')).toBe('en-gb')
    expect(toTranslatorLanguage('en-US')).toBe('en-us')
    expect(toTranslatorLanguage('pt-BR')).toBe('pt')
    expect(toTranslatorLanguage('DE')).toBe('de')
    expect(toTranslatorLanguage('tr')).toBeNull()
    expect(toTranslatorLanguage(undefined)).toBeNull()
  })

  it('fills the engine settings of a config stored before they existed', () => {
    expect(translatorComponentConfigSchema.parse({ defaultTargetLanguage: 'en' })).toEqual({
      defaultTargetLanguage: 'en-gb',
      deeplApiUrl: null,
      llmBaseUrl: null,
      llmModels: [],
      llmProviderName: null,
      defaultEngine: null,
      documentsEnabled: false
    })
  })

  it('reads the document upload fields', () => {
    expect(translatorDocumentUploadSchema.parse({ target: 'en-gb' })).toEqual({
      source: null,
      target: 'en-gb',
      formality: 'default',
      glossaryIds: []
    })
    expect(translatorDocumentUploadSchema.parse({ source: '', target: 'de' }).source).toBeNull()
    expect(translatorDocumentUploadSchema.parse({ source: 'fr', target: 'de' }).source).toBe('fr')
    expect(translatorDocumentUploadSchema.safeParse({ source: 'xx', target: 'de' }).success).toBe(
      false
    )
  })

  it('takes the document types DeepL translates, pictures too', () => {
    expect(translatorDocumentExtension('Bericht.DOCX')).toBe('docx')
    expect(translatorDocumentExtension('folien.v2.pptx')).toBe('pptx')
    expect(translatorDocumentExtension('untertitel.srt')).toBe('srt')
    expect(translatorDocumentExtension('bild.png')).toBe('png')
    expect(translatorDocumentExtension('archiv.zip')).toBeNull()
    expect(translatorDocumentExtension('pdf')).toBeNull()
  })

  it('rejects duplicate model ids', () => {
    const model = { id: 'llama', label: 'Llama' }
    expect(
      translatorComponentConfigSchema.safeParse({
        defaultTargetLanguage: 'en-gb',
        llmModels: [model, { ...model, label: 'Other' }]
      }).success
    ).toBe(false)
  })

  it('names engines as deepl or llm:<model id>', () => {
    expect(translatorEngineIdSchema.safeParse('deepl').success).toBe(true)
    expect(translatorEngineIdSchema.safeParse('llm:meta-llama-3.1-8b-instruct').success).toBe(true)
    expect(translatorEngineIdSchema.safeParse('llm:').success).toBe(false)
    expect(translatorEngineIdSchema.safeParse('google').success).toBe(false)
  })

  it('defaults formality, style, tone and glossaries', () => {
    expect(
      translateRequestSchema.parse({ text: ['Hallo'], source: null, target: 'en-gb' }).formality
    ).toBe('default')
    expect(rephraseRequestSchema.parse({ text: ['Hallo'] })).toEqual({
      text: ['Hallo'],
      language: null,
      formality: 'default',
      style: null,
      tone: null,
      glossaryIds: []
    })
    expect(rephraseRequestSchema.safeParse({ text: ['Hallo'], style: 'poetic' }).success).toBe(
      false
    )
  })

  it('reads glossary CSV files of two columns', () => {
    expect(parseGlossaryCsv('Prüfung,exam\r\n"Amt, zentral",office\n\n')).toEqual([
      { source: 'Prüfung', target: 'exam' },
      { source: 'Amt, zentral', target: 'office' }
    ])
    expect(parseGlossaryCsv('Prüfung;exam\nAmt;office')).toEqual([
      { source: 'Prüfung', target: 'exam' },
      { source: 'Amt', target: 'office' }
    ])
    expect(parseGlossaryCsv('nur eine Spalte\nzweite')).toBeNull()
    expect(parseGlossaryCsv('')).toBeNull()
  })

  it('limits glossary texts as HAWKI does: names by characters, descriptions by bytes', () => {
    const entry = { sourceLanguage: 'de', sourceTerm: 'a', targetLanguage: 'en', targetTerm: 'b' }
    const glossary = (name: string, description = '') =>
      translatorGlossaryInputSchema.safeParse({ name, description, entries: [entry] }).success
    expect(glossary('N'.repeat(255))).toBe(true)
    expect(glossary('😀'.repeat(255))).toBe(true)
    expect(
      translatorGlossaryInputSchema.safeParse({ name: 'N'.repeat(256), entries: [entry] }).error
        ?.issues[0]?.message
    ).toBe(TRANSLATOR_GLOSSARY_TOO_LONG)
    expect(translatorGlossaryPatchSchema.safeParse({ category: 'C'.repeat(256) }).success).toBe(
      false
    )
    expect(glossary('n', 'D'.repeat(65_535))).toBe(true)
    expect(glossary('n', 'ä'.repeat(32_768))).toBe(false)
    expect(
      translatorGlossaryEntrySchema.safeParse({ ...entry, sourceTerm: 'S'.repeat(5000) }).success
    ).toBe(true)
    expect(
      translatorGlossaryInputSchema.safeParse({ name: 'n', entries: Array(5001).fill(entry) })
        .success
    ).toBe(true)
  })

  it('takes glossary changes of the category and the rights, but not none at all', () => {
    expect(
      translatorGlossaryPatchSchema.parse({
        category: ' R8TEST ',
        visibility: 'organization',
        visibleTo: 'student',
        editorRole: null
      })
    ).toEqual({
      category: 'R8TEST',
      visibility: 'organization',
      visibleTo: 'student',
      editorRole: null
    })
    expect(translatorGlossaryPatchSchema.safeParse({}).success).toBe(false)
    expect(translatorGlossaryPatchSchema.safeParse({ visibleTo: 'Studierende' }).success).toBe(
      false
    )
  })
})

describe('desktop links', () => {
  it('maps jlucampus:// links to in-app paths and back', () => {
    expect(desktopLinkPath('jlucampus://c/abc')).toBe('/c/abc')
    expect(desktopLinkPath('jlucampus://d/files/')).toBe('/d/files')
    expect(desktopLinkPath('jlucampus://')).toBe('/')
    expect(desktopLinkFor('/c/abc')).toBe('jlucampus://c/abc')
  })

  it('refuses other schemes and paths that leave the app', () => {
    expect(desktopLinkPath('https://example.org/c/abc')).toBeNull()
    expect(desktopLinkPath('jlucampus:///evil.example')).toBeNull()
    expect(desktopLinkPath('not a url')).toBeNull()
  })
})
