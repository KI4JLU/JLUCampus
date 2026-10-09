import { describe, expect, it, vi } from 'vitest'
import type { RephraseRequest, TranslateRequest, TranslatorEngine } from '@justcampus/shared'
import {
  parseSession,
  SESSION_KEY,
  TranslatorStore,
  type TranslatorApi,
  type TranslatorClock
} from './translator-store'

const engines: TranslatorEngine[] = [
  { id: 'deepl', kind: 'deepl', label: 'DeepL' },
  { id: 'llm:gemma', kind: 'llm', label: 'Gemma' }
]

/** What the page tells the store: every mode offered and allowed. */
const context = {
  engines,
  defaultEngine: 'deepl',
  documents: true,
  rephrase: true,
  create: true
} as const

/** Timers run by hand, so the store's pauses are instant and ordered. */
function manualClock(): TranslatorClock & { run: () => void } {
  let timers: Array<{ callback: () => void; handle: number }> = []
  let next = 0
  return {
    setTimeout: (callback) => {
      const handle = ++next
      timers.push({ callback, handle })
      return handle
    },
    clearTimeout: (handle) => {
      timers = timers.filter((timer) => timer.handle !== handle)
    },
    run: () => {
      const due = timers
      timers = []
      for (const timer of due) timer.callback()
    }
  }
}

function setup(overrides: Partial<TranslatorApi> = {}): {
  store: TranslatorStore
  api: TranslatorApi
  storage: { setItem: ReturnType<typeof vi.fn> }
  clock: ReturnType<typeof manualClock>
} {
  const api: TranslatorApi = {
    translate: vi.fn(async (request: TranslateRequest) => ({
      text: request.text.map((sentence) => `EN:${sentence.trim()}`),
      detectedSource: null
    })),
    rephrase: vi.fn(async (request: RephraseRequest) => ({
      text: request.text.map((sentence) => sentence.toUpperCase()),
      detectedLanguage: null
    })),
    detect: vi.fn(async () => 'de' as const),
    suggest: vi.fn(async () => ['Andere Formulierung.']),
    ...overrides
  }
  const storage = { setItem: vi.fn() }
  const clock = manualClock()
  const store = new TranslatorStore(api, parseSession(null, 'en-gb'), storage, clock)
  store.setContext({ ...context, glossaryIds: [] })
  return { store, api, storage, clock }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('TranslatorStore', () => {
  it('starts with Automatisch → Englisch (UK) and the session defaults', () => {
    const { store } = setup()
    const state = store.getState()
    expect(state.mode).toBe('translate')
    expect(state.translate.sourceLang).toBe('auto')
    expect(state.translate.targetLang).toBe('en-gb')
    expect(state.live).toBe(false)
    expect(state.aiContextMenu).toBe(true)
    expect(state.formatting).toBe(true)
  })

  it('detects the language of a longer text after a pause, unless the user chose one', async () => {
    const { store, api, clock } = setup()
    store.setSource('Das ist ein deutscher Text mit genug Zeichen.')
    clock.run()
    await flush()
    expect(api.detect).toHaveBeenCalledWith({
      text: 'Das ist ein deutscher Text mit genug Zeichen.',
      engine: 'deepl'
    })
    expect(store.getState().translate.sourceLang).toBe('de')

    store.setSourceLang('fr')
    store.setSource('Das ist ein anderer deutscher Text, lang genug.')
    clock.run()
    await flush()
    expect(store.getState().translate.sourceLang).toBe('fr')
  })

  it('never lets source and target match', () => {
    const { store } = setup()
    store.setSourceLang('en-gb')
    expect(store.getState().translate.targetLang).toBe('de')
    store.setTargetLang('en-gb')
    expect(store.getState().translate.sourceLang).toBe('auto')
  })

  it('sends the text sentence by sentence and then keeps the button off until something changes', async () => {
    const { store, api } = setup()
    store.setSource('Guten Morgen. Bis bald.')
    expect(store.hasChanges).toBe(true)
    await store.run()
    const request = vi.mocked(api.translate).mock.calls[0]![0]
    expect(request).toMatchObject({
      text: ['Guten Morgen. ', 'Bis bald.'],
      source: 'de',
      target: 'en-gb',
      engine: 'deepl',
      formality: 'default',
      glossaryIds: []
    })
    expect(store.targetText).toBe('EN:Guten Morgen. EN:Bis bald.')
    expect(store.hasChanges).toBe(false)
    store.selectFormality('formal')
    expect(store.hasChanges).toBe(true)
  })

  it('redoes only the changed sentence and keeps the user’s edit of the others', async () => {
    const { store, api } = setup()
    store.setSource('Eins. Zwei. Drei.')
    await store.run()
    store.setTarget('Mein eins. EN:Zwei. EN:Drei.')
    store.setSource('Eins. Zwei neu. Drei.')
    await store.run()
    expect(vi.mocked(api.translate)).toHaveBeenCalledTimes(2)
    expect(store.targetText).toBe('Mein eins. EN:Zwei neu. EN:Drei.')
  })

  it('lets style, tone and formality exclude each other', () => {
    const { store } = setup()
    store.selectStyle('academic')
    store.selectTone('friendly')
    expect(store.getState()).toMatchObject({ style: null, tone: 'friendly', formality: 'default' })
    store.selectFormality('informal')
    expect(store.getState()).toMatchObject({ style: null, tone: null, formality: 'informal' })
    store.resetStyle()
    expect(store.getState()).toMatchObject({ style: null, tone: null, formality: 'default' })
  })

  it('swaps languages and texts and translates the new source', async () => {
    const { store, api } = setup()
    store.setSource('Hallo Welt.')
    await store.run()
    store.swap()
    await flush()
    const state = store.getState().translate
    expect(state.sourceLang).toBe('en-gb')
    expect(state.targetLang).toBe('de')
    expect(state.source).toBe('EN:Hallo Welt.')
    expect(vi.mocked(api.translate).mock.calls[1]![0]).toMatchObject({
      source: 'en-gb',
      target: 'de'
    })
  })

  it('keeps the shown result when the translation after a swap fails', async () => {
    const translate = vi.fn(async (request: TranslateRequest) => {
      if (request.source === 'en-gb') throw new Error('DeepL refused EN-GB')
      return { text: request.text.map((sentence) => `EN:${sentence.trim()}`), detectedSource: null }
    })
    const { store } = setup({ translate })
    store.setSource('Hallo Welt.')
    await store.run()
    store.swap()
    await flush()
    const state = store.getState().translate
    expect(state.source).toBe('EN:Hallo Welt.')
    expect(store.targetText).toBe('EN:Hallo Welt.')
    expect(state.sourceSentences).toEqual(['Hallo Welt.'])
    expect(store.getState().error).toBeInstanceOf(Error)
    // As HAWKI's output field, copying takes the old source meanwhile, until the result changes.
    expect(store.outputText).toBe('Hallo Welt.')
    store.setTarget('Eigener Text.')
    expect(store.outputText).toBe('Eigener Text.')
  })

  it('leaves detected English as "Automatisch" and lets the engine tell it', async () => {
    const { store, api } = setup({ detect: vi.fn(async () => 'en-gb' as const) })
    store.setTargetLang('de')
    store.setSource('This is an English sentence.')
    await store.run()
    expect(store.getState().translate.sourceLang).toBe('auto')
    expect(vi.mocked(api.translate).mock.calls[0]![0]).toMatchObject({ source: null })
  })

  it('moves a result into the other text mode from the translation’s target language', async () => {
    const { store } = setup()
    store.setTargetLang('en-us')
    store.setSource('Hallo Welt.')
    await store.run()
    store.improveTarget()
    expect(store.getState().mode).toBe('rephrase')
    expect(store.getState().rephrase.sourceLang).toBe('en-us')
    await flush()
    // Back from rewriting, HAWKI takes the translation's target again, not the text's language.
    store.translateTarget()
    const state = store.getState()
    expect(state.mode).toBe('translate')
    expect(state.translate).toMatchObject({ sourceLang: 'en-us', targetLang: 'de' })
    expect(state.userSetSourceLang).toBe(true)
  })

  it('offers live editing with a model only, and sends a finished sentence right away', async () => {
    const { store, api } = setup()
    store.setLive(true)
    expect(store.liveActive).toBe(false)
    store.selectEngine('llm:gemma')
    expect(store.liveActive).toBe(true)
    store.setSource('Ein fertiger Satz.')
    await flush()
    expect(vi.mocked(api.translate)).toHaveBeenCalledTimes(1)
  })

  it('clears the result and the detected language with the text', async () => {
    const { store } = setup()
    store.setSource('Hallo Welt.')
    await store.run()
    store.clearSource()
    const state = store.getState().translate
    expect(state).toMatchObject({ source: '', sourceLang: 'auto', targetSentences: [] })
  })

  it('undoes a changed sentence and knows which ones the user added', async () => {
    const { store } = setup()
    store.setSource('Eins. Zwei drei vier.')
    await store.run()
    store.setTarget('EN:Eins. EN:Zwei drei fünf. Ganz eigener Satz.')
    expect(store.isSentenceChanged(1)).toBe(true)
    store.undoSentence(1)
    expect(store.targetText).toBe('EN:Eins. EN:Zwei drei vier. Ganz eigener Satz.')
    expect(store.sourceIndexOf(2)).toBeNull()
  })

  it('keeps the session in storage', async () => {
    const { store, storage } = setup()
    store.setSource('Hallo')
    const [key, value] = storage.setItem.mock.calls.at(-1)!
    expect(key).toBe(SESSION_KEY)
    const session = parseSession(value, 'en-gb')
    expect(session.translate.source).toBe('Hallo')
    expect('loading' in JSON.parse(value)).toBe(false)
  })

  it('drops the active glossaries on a reload and keeps the button off', async () => {
    const { store, storage } = setup()
    store.setContext({ ...context, glossaryIds: ['g1'] })
    store.setGlossaries(['g1'])
    store.setSource('Hallo Welt.')
    await store.run()
    const [, value] = storage.setItem.mock.calls.at(-1)!
    expect('glossaryIds' in JSON.parse(value)).toBe(false)
    const reloaded = new TranslatorStore(setup().api, parseSession(value, 'en-gb'), null)
    reloaded.setContext({ ...context, glossaryIds: ['g1'] })
    expect(reloaded.getState().glossaryIds).toEqual([])
    expect(reloaded.targetText).toBe('EN:Hallo Welt.')
    expect(reloaded.hasChanges).toBe(false)
  })

  it('shows the closed notice again after a reload, and web search on', () => {
    const { store, storage } = setup()
    store.closeNotice()
    store.setWebSearch(false)
    const [, value] = storage.setItem.mock.calls.at(-1)!
    const reloaded = new TranslatorStore(setup().api, parseSession(value, 'en-gb'), null)
    expect(store.getState()).toMatchObject({ noticeClosed: true, webSearch: false })
    expect(reloaded.getState()).toMatchObject({ noticeClosed: false, webSearch: true })
  })

  it('gives way to translating when the user may no longer use the mode', () => {
    const { store } = setup()
    store.switchMode('rephrase')
    store.setContext({ ...context, rephrase: false, glossaryIds: [] })
    expect(store.getState().mode).toBe('translate')
    store.switchMode('create')
    store.setContext({ ...context, create: false, glossaryIds: [] })
    expect(store.getState().mode).toBe('translate')
    store.switchMode('documents')
    store.setContext({ ...context, documents: false, glossaryIds: [] })
    expect(store.getState().mode).toBe('translate')
  })

  it('keeps the documents’ target while the mode changes, and resets it on a reload', () => {
    const { store, storage } = setup()
    store.setDocTargetLang('fr')
    store.switchMode('documents')
    store.switchMode('translate')
    expect(store.getState().docTargetLang).toBe('fr')
    const [, value] = storage.setItem.mock.calls.at(-1)!
    expect('docTargetLang' in JSON.parse(value)).toBe(false)
    const reloaded = new TranslatorStore(setup().api, parseSession(value, 'de'), null)
    expect(reloaded.getState().docTargetLang).toBe('de')
  })

  it('shows the editor’s text in an empty output after a reload, as HAWKI does', async () => {
    const { store, storage } = setup()
    store.setCreateHtml('<p>EDITOR_R9_Neuladen</p>', 'EDITOR\\_R9\\_Neuladen')
    store.setSource('Hallo Welt.')
    await store.run()
    store.setSource('Ein anderer Text.', true)
    expect(store.targetText).toBe('')
    const [, value] = storage.setItem.mock.calls.at(-1)!
    const reloaded = new TranslatorStore(setup().api, parseSession(value, 'en-gb'), null)
    reloaded.setContext({ ...context, glossaryIds: [] })
    expect(reloaded.targetText).toBe('EDITOR\\_R9\\_Neuladen')
    expect(reloaded.buffer.sourceSentences).toEqual(['Ein anderer Text.'])
    // The reloaded text counts as processed: the button stays off until something changes.
    expect(reloaded.hasChanges).toBe(false)
    reloaded.setSource('Ein anderer Text. Noch einer.')
    expect(reloaded.hasChanges).toBe(true)
  })

  it('reloads the editor formatted, with the document as it was before the Markdown edits', () => {
    const { store, storage } = setup()
    store.setCreateHtml('<p>Ein fehlerhafte Text.</p>', 'Ein fehlerhafte Text.')
    store.setFormatting(false)
    store.setCreateMarkdown('# Neue Markdownfassung\n\nNur Markdown vor Reload.')
    store.setCreateCount('# Neue Markdownfassung\n\nNur Markdown vor Reload.')
    const [, value] = storage.setItem.mock.calls.at(-1)!
    const reloaded = new TranslatorStore(setup().api, parseSession(value, 'en-gb'), null)
    // The counts count the document again, as HAWKI counts it after loading.
    expect(reloaded.getState()).toMatchObject({
      formatting: true,
      createMarkdown: null,
      createCount: null,
      createHtml: '<p>Ein fehlerhafte Text.</p>'
    })
  })
})
