import { z } from 'zod'
import {
  rephraseStyleSchema,
  rephraseToneSchema,
  TRANSLATOR_DETECT_SAMPLE_MAX,
  translatorEngineIdSchema,
  translatorFormalitySchema,
  translatorLanguageSchema,
  type RephraseRequest,
  type RephraseResponse,
  type RephraseStyle,
  type RephraseTone,
  type TranslateRequest,
  type TranslateResponse,
  type TranslatorDetectRequest,
  type TranslatorEngine,
  type TranslatorEngineId,
  type TranslatorFormality,
  type TranslatorLanguage,
  type TranslatorSuggestRequest
} from '@justcampus/shared'
import { alternativeTarget, TEXT_ERROR_MS, type SourceLanguage } from './languages'
import {
  completeSentenceCount,
  sentenceMapping,
  sentenceTokens,
  splitIntoSentences,
  withTrailingWhitespace
} from './sentences'

/** The four ways of working, in HAWKI's order; `documents` only while the module offers it. */
export const TRANSLATOR_MODES = ['translate', 'documents', 'rephrase', 'create'] as const
export const translatorModeSchema = z.enum(TRANSLATOR_MODES)
export type TranslatorMode = z.infer<typeof translatorModeSchema>

/** The two modes with a source text and a result beside it. */
export type TextMode = 'translate' | 'rephrase'

/** How long typing has to pause before detection, or live editing, looks at the text. */
export const TYPING_PAUSE_MS = 800
/** Characters detection samples while typing; the detection before a request takes more. */
const DETECT_TYPING_SAMPLE = 50
/** Below this many characters a text is too short to tell its language. */
const DETECT_MIN_LENGTH = 20

const sourceLanguageSchema = z.union([z.literal('auto'), translatorLanguageSchema])

/** One text mode's text, languages and result, kept while the other modes are used. */
const textBufferSchema = z.object({
  source: z.string().catch(''),
  sourceLang: sourceLanguageSchema.catch('auto'),
  targetLang: translatorLanguageSchema.catch('en-gb'),
  sourceSentences: z.array(z.string()).catch([]),
  targetSentences: z.array(z.string()).catch([]),
  /** The result as the engine gave it, before the user edited it; undo goes back to it. */
  baselineTargetSentences: z.array(z.string()).catch([]),
  /** The source as it was processed; "show changes" compares against it. */
  lastSourceText: z.string().catch(''),
  /**
   * What HAWKI's output field holds while it differs from the result shown: after a swap the old
   * source, until a new result replaces it. Copying and passing the result on take this text.
   */
  outputText: z.string().nullable().catch(null)
})
export type TextBuffer = z.infer<typeof textBufferSchema>

/** What a result was made with: the button stays off until one of them changes. */
const processedSchema = z.object({
  text: z.string(),
  sourceLang: z.string(),
  targetLang: z.string().nullable(),
  engine: z.string().nullable(),
  style: z.string().nullable(),
  tone: z.string().nullable(),
  formality: z.string(),
  glossaries: z.string()
})
type Processed = z.infer<typeof processedSchema>

/**
 * The page's state, kept in `sessionStorage` like HAWKI's text session: it survives a reload of
 * the tab, and a new tab starts fresh. Each field falls back on its own.
 */
const sessionSchema = z.object({
  mode: translatorModeSchema.catch('translate'),
  translate: textBufferSchema.catch(() => textBufferSchema.parse({})),
  rephrase: textBufferSchema.catch(() => textBufferSchema.parse({})),
  processed: z
    .object({
      translate: processedSchema.nullable().catch(null),
      rephrase: processedSchema.nullable().catch(null)
    })
    .catch({ translate: null, rephrase: null }),
  /** The engine the user picked last; documents and the editor may use another one meanwhile. */
  engine: translatorEngineIdSchema.nullable().catch(null),
  style: rephraseStyleSchema.nullable().catch(null),
  tone: rephraseToneSchema.nullable().catch(null),
  formality: translatorFormalitySchema.catch('default'),
  live: z.boolean().catch(false),
  showChanges: z.boolean().catch(false),
  aiContextMenu: z.boolean().catch(true),
  /** The documents' target: kept while the mode changes, the default again after a reload. */
  docTargetLang: translatorLanguageSchema.catch('en-gb'),
  /** The AI editor's document as HTML, which keeps all of its formatting. */
  createHtml: z.string().catch(''),
  /** The same document as Markdown, as HAWKI keeps it beside the HTML. */
  createText: z.string().catch(''),
  userSetSourceLang: z.boolean().catch(false)
})
export type TranslatorSession = z.infer<typeof sessionSchema>

export const SESSION_KEY = 'justcampus.translator.session'

/** The session stored in this tab; anything unreadable gives the defaults. */
export function parseSession(
  stored: string | null,
  defaultTarget: TranslatorLanguage
): TranslatorSession {
  const fresh = sessionSchema.parse({})
  fresh.translate.targetLang = defaultTarget
  fresh.docTargetLang = defaultTarget
  if (!stored) return fresh
  try {
    const parsed = sessionSchema.safeParse(JSON.parse(stored))
    if (!parsed.success) return fresh
    // The glossaries start unselected again, and a result counts as made without them.
    const { translate, rephrase } = parsed.data.processed
    const session = {
      ...parsed.data,
      // As in HAWKI, the documents' target starts at the default again.
      docTargetLang: defaultTarget,
      processed: {
        translate: translate && { ...translate, glossaries: '' },
        rephrase: rephrase && { ...rephrase, glossaries: '' }
      }
    }
    if (session.mode !== 'translate' && session.mode !== 'rephrase') return session
    return { ...session, [session.mode]: reloadedBuffer(session[session.mode], session.createText) }
  } catch {
    return fresh
  }
}

/**
 * The shown text mode as HAWKI reloads it: the source counts as split into its sentences. An
 * empty output takes the AI editor's document as Markdown instead (HAWKI's editor reports its
 * content into the shared result on loading), so the editor's text shows as the result.
 */
function reloadedBuffer(buffer: TextBuffer, createText: string): TextBuffer {
  const output = buffer.outputText ?? buffer.targetSentences.join('')
  return {
    ...buffer,
    sourceSentences: buffer.source ? splitIntoSentences(buffer.source) : [],
    ...(output
      ? {}
      : {
          targetSentences: createText.trim() ? splitIntoSentences(createText) : [],
          outputText: null
        })
  }
}

/** The state as components see it: the session and what is going on right now. */
export interface TranslatorState extends TranslatorSession {
  /** A request of the current mode is on its way. */
  loading: boolean
  /** The sentences being redone while loading; `null`: the whole result. */
  pendingSentences: number[] | null
  /** The message of the last failure, shown for a few seconds. */
  error: unknown
  /** A shown sentence's detection is going on (live typing). */
  detecting: boolean
  /** Counts changes of the offered engines and glossaries, which change what is shown. */
  contextVersion: number
  /** The test notice was closed; as in HAWKI it is back after a reload. */
  noticeClosed: boolean
  /** The editor's web search, on until switched off; as in HAWKI it is on again after a reload. */
  webSearch: boolean
  /** The active glossaries; as in HAWKI none are active again after a reload. */
  glossaryIds: string[]
  /** The editor's formatting; as in HAWKI it is on again after a reload. */
  formatting: boolean
  /**
   * The editor's Markdown text while formatting is off, `null` while it is on. The document
   * (`createHtml`) takes it back only when formatting is turned on again, so a reload before
   * that shows the document as it was, as in HAWKI.
   */
  createMarkdown: string | null
  /**
   * What the editor's counts count, as HAWKI sets them: the Markdown text as typed while
   * formatting is off, `null` (the document) after each change of the document. Turning
   * formatting on again leaves them as they are when the document stays the same.
   */
  createCount: string | null
}

/** The parts of the state that describe the moment, not the session. */
const TRANSIENT_KEYS = new Set([
  'loading',
  'pendingSentences',
  'error',
  'detecting',
  'contextVersion',
  'noticeClosed',
  'webSearch',
  'glossaryIds',
  'formatting',
  'createMarkdown',
  'createCount',
  'docTargetLang'
])

/** What the store asks the server for; injected, so tests need no network. */
export interface TranslatorApi {
  translate: (request: TranslateRequest, signal?: AbortSignal) => Promise<TranslateResponse>
  rephrase: (request: RephraseRequest, signal?: AbortSignal) => Promise<RephraseResponse>
  detect: (
    request: TranslatorDetectRequest,
    signal?: AbortSignal
  ) => Promise<TranslatorLanguage | null>
  suggest: (request: TranslatorSuggestRequest, signal?: AbortSignal) => Promise<string[]>
}

/** What the store needs from the page around it. */
export interface TranslatorContext {
  engines: readonly TranslatorEngine[]
  defaultEngine: TranslatorEngineId | null
  /** Whether document translation is offered: set up by the admin and allowed to the user. */
  documents: boolean
  /** Whether the user may rewrite texts and use the AI editor (their roles' functions). */
  rephrase: boolean
  create: boolean
  /** Ids of the glossaries the user can use; `null` until they are known. */
  glossaryIds: readonly string[] | null
}

/** Timers, replaceable in tests. */
export interface TranslatorClock {
  setTimeout: (callback: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

/** A suggestion list for one sentence or one word of the result. */
export interface SuggestionTarget {
  index: number
  /** The clicked word's token index, for word suggestions. */
  tokenIndex: number | null
  kind: 'sentence' | 'word'
}

type Listener = () => void

/**
 * The text modes after HAWKI's translator: a text is translated or rewritten sentence by
 * sentence, the result stays editable, and a request only goes out when the text or a setting
 * changed since the result was made. The store owns the text, the languages and the settings of
 * the style panel; components render its state and call its methods.
 */
export class TranslatorStore {
  private state: TranslatorState
  private readonly listeners = new Set<Listener>()
  private context: TranslatorContext = {
    engines: [],
    defaultEngine: null,
    documents: false,
    rephrase: false,
    create: false,
    glossaryIds: null
  }
  private detectTimer: unknown = null
  private liveTimer: unknown = null
  private errorTimer: unknown = null
  private detectCache: { sample: string; language: TranslatorLanguage | null } | null = null
  private request: AbortController | null = null
  /** Suggestions shown per sentence (`index`) or word (`index-token`), until the mode changes. */
  private suggestionCache = new Map<string, string[]>()
  /** The session's text still counts as processed once the engines are known (`setContext`). */
  private loaded = false

  constructor(
    private readonly api: TranslatorApi,
    session: TranslatorSession,
    private readonly storage: Pick<Storage, 'setItem'> | null,
    private readonly clock: TranslatorClock = {
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
    }
  ) {
    this.state = {
      ...session,
      loading: false,
      pendingSentences: null,
      error: null,
      detecting: false,
      contextVersion: 0,
      noticeClosed: false,
      webSearch: true,
      glossaryIds: [],
      formatting: true,
      createMarkdown: null,
      createCount: null
    }
  }

  // --- Subscription -----------------------------------------------------------------------------

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState = (): TranslatorState => this.state

  private set(patch: Partial<TranslatorState>): void {
    this.state = { ...this.state, ...patch }
    this.save()
    for (const listener of this.listeners) listener()
  }

  private save(): void {
    if (!this.storage) return
    const session = Object.fromEntries(
      Object.entries(this.state).filter(([key]) => !TRANSIENT_KEYS.has(key))
    )
    try {
      this.storage.setItem(SESSION_KEY, JSON.stringify(session))
    } catch {
      /* A lost session costs nothing but the session. */
    }
  }

  /** The offered engines and glossaries; unknown glossaries drop out of the selection. */
  setContext(context: TranslatorContext): void {
    this.context = context
    this.set({ contextVersion: this.state.contextVersion + 1 })
    if (!this.loaded && context.engines.length > 0) {
      this.loaded = true
      this.markLoadedProcessed()
    }
    const known = context.glossaryIds
    if (known && this.state.glossaryIds.some((id) => !known.includes(id))) {
      this.set({ glossaryIds: this.state.glossaryIds.filter((id) => known.includes(id)) })
    }
    // A mode that is no longer offered gives way to translating.
    const offered =
      this.state.mode === 'documents'
        ? context.documents
        : this.state.mode === 'create'
          ? context.create && context.engines.some((engine) => engine.kind === 'llm')
          : this.state.mode === 'rephrase'
            ? context.rephrase
            : true
    if (!offered && context.engines.length > 0) this.set({ mode: 'translate' })
  }

  /**
   * As HAWKI loads its session, the shown text counts as processed with the settings there are:
   * the button stays off after a reload until the text or a setting changes.
   */
  private markLoadedProcessed(): void {
    if (this.state.mode !== 'translate' && this.state.mode !== 'rephrase') return
    const buffer = this.buffer
    const text = buffer.source.trim()
    if (!text) return
    this.set({
      processed: {
        ...this.state.processed,
        [this.textMode]: this.snapshot(text, buffer.sourceLang, this.currentTarget())
      }
    })
  }

  dispose(): void {
    for (const timer of [this.detectTimer, this.liveTimer, this.errorTimer])
      this.clock.clearTimeout(timer)
    this.request?.abort()
  }

  // --- Derived ---------------------------------------------------------------------------------

  /** The text mode shown; the others count as translating for the text they keep. */
  get textMode(): TextMode {
    return this.state.mode === 'rephrase' ? 'rephrase' : 'translate'
  }

  get buffer(): TextBuffer {
    return this.state[this.textMode]
  }

  /**
   * The engine requests of the current mode go to: DeepL for documents, a model for the editor,
   * else the user's choice while it is offered, else the default. `null` while none is known.
   */
  engineFor(mode: TranslatorMode = this.state.mode): TranslatorEngine | null {
    const { engines, defaultEngine } = this.context
    if (mode === 'documents') return engines.find((engine) => engine.kind === 'deepl') ?? null
    const allowed = mode === 'create' ? engines.filter((engine) => engine.kind === 'llm') : engines
    return (
      allowed.find((engine) => engine.id === this.state.engine) ??
      allowed.find((engine) => engine.id === defaultEngine) ??
      allowed[0] ??
      null
    )
  }

  /** Live editing works with a model only: with DeepL it would bill a request per pause. */
  get liveActive(): boolean {
    return this.state.live && this.engineFor()?.kind === 'llm'
  }

  private glossaryKey(): string {
    return [...this.state.glossaryIds].sort().join(',')
  }

  private snapshot(text: string, sourceLang: string, targetLang: string | null): Processed {
    return {
      text,
      sourceLang,
      targetLang,
      engine: this.engineFor()?.id ?? null,
      style: this.state.style,
      tone: this.state.tone,
      formality: this.state.formality,
      glossaries: this.glossaryKey()
    }
  }

  private currentTarget(): string | null {
    const buffer = this.buffer
    return this.textMode === 'rephrase'
      ? buffer.sourceLang === 'auto'
        ? null
        : buffer.sourceLang
      : buffer.targetLang
  }

  /**
   * Whether the main button does anything: there is text, no request is on its way, and the
   * text or a setting changed since the shown result was made.
   */
  get hasChanges(): boolean {
    if (this.state.loading) return false
    const buffer = this.buffer
    const text = buffer.source.trim()
    if (!text) return false
    const processed = this.state.processed[this.textMode]
    if (!processed) return true
    const now = this.snapshot(text, buffer.sourceLang, this.currentTarget())
    return (Object.keys(now) as Array<keyof Processed>).some((key) => now[key] !== processed[key])
  }

  get targetText(): string {
    return this.buffer.targetSentences.join('')
  }

  /** The text of the output as copying and passing it on see it. */
  get outputText(): string {
    return this.buffer.outputText ?? this.targetText
  }

  // --- Buffers ---------------------------------------------------------------------------------

  /** Any change of the result makes the output field hold it again. */
  private patchBuffer(patch: Partial<TextBuffer>, mode: TextMode = this.textMode): void {
    const output =
      'targetSentences' in patch && !('outputText' in patch) ? { outputText: null } : {}
    this.set({ [mode]: { ...this.state[mode], ...output, ...patch } } as Partial<TranslatorState>)
  }

  private clearResult(mode: TextMode = this.textMode): void {
    this.patchBuffer(
      { targetSentences: [], baselineTargetSentences: [], sourceSentences: [], lastSourceText: '' },
      mode
    )
    this.set({ processed: { ...this.state.processed, [mode]: null } })
    this.suggestionCache.clear()
  }

  // --- Source text -----------------------------------------------------------------------------

  /**
   * The source text as typed. An emptied field, or one whose whole content was replaced, starts
   * over: the result goes and the source language is detected again.
   */
  setSource(value: string, replacedAll = false): void {
    this.patchBuffer({ source: value })
    if (!value.trim() || replacedAll) {
      if (this.buffer.sourceLang !== 'auto') this.setSourceLang('auto', true)
      this.clearResult()
      if (!value.trim()) return
    }
    this.scheduleDetection()
    this.scheduleLive(value)
  }

  /** The source cleared with its button: text, result and language start over. */
  clearSource(): void {
    this.patchBuffer({ source: '' })
    if (this.buffer.sourceLang !== 'auto') this.setSourceLang('auto', true)
    this.clearResult()
  }

  /** The result as the user edited it. */
  setTarget(value: string): void {
    this.patchBuffer({ targetSentences: value.trim() ? splitIntoSentences(value) : [] })
  }

  // --- Languages -------------------------------------------------------------------------------

  /**
   * Chooses the source language. A choice by the user (`programmatic` false) is kept while the
   * text changes; detection only fills in `auto`.
   */
  setSourceLang(language: SourceLanguage, programmatic = false): void {
    if (!programmatic) this.set({ userSetSourceLang: language !== 'auto' })
    this.patchBuffer({ sourceLang: language })
    this.preventSameLanguage('source')
    if (!programmatic) this.runLiveNow()
  }

  setTargetLang(language: TranslatorLanguage): void {
    this.patchBuffer({ targetLang: language })
    this.preventSameLanguage('target')
    this.runLiveNow()
  }

  /**
   * Source and target never match while translating: a source like the target gets another
   * target, a target like the source sets the source back to `auto`.
   */
  private preventSameLanguage(side: 'source' | 'target'): void {
    if (this.textMode === 'rephrase') return
    const { sourceLang, targetLang } = this.state.translate
    if (sourceLang === 'auto' || sourceLang !== targetLang) return
    if (side === 'source')
      this.patchBuffer({ targetLang: alternativeTarget(sourceLang) }, 'translate')
    else this.patchBuffer({ sourceLang: 'auto' }, 'translate')
  }

  /**
   * Swaps the languages and the texts, then translates the new source if there is one. With the
   * source detected (`auto`) the new target is an alternative to the old one. As in HAWKI, a
   * result that is shown stays until the new one replaces it; a failed request leaves it there,
   * while the output field already holds the old source.
   */
  swap(): void {
    const buffer = this.state.translate
    const source = buffer.targetLang
    const target =
      buffer.sourceLang === 'auto' ? alternativeTarget(buffer.targetLang) : buffer.sourceLang
    const newSource = this.outputText
    const newTarget = buffer.source
    const shown = this.state.processed.translate !== null && buffer.targetSentences.length > 0
    this.set({ userSetSourceLang: true })
    this.patchBuffer(
      {
        sourceLang: source,
        targetLang: target,
        source: newSource,
        ...(shown
          ? { outputText: newTarget }
          : { targetSentences: newTarget ? splitIntoSentences(newTarget) : [] })
      },
      'translate'
    )
    this.preventSameLanguage('source')
    if (newSource.trim()) void this.run()
  }

  // --- Detection -------------------------------------------------------------------------------

  private scheduleDetection(): void {
    this.clock.clearTimeout(this.detectTimer)
    this.detectTimer = this.clock.setTimeout(() => void this.detectWhileTyping(), TYPING_PAUSE_MS)
  }

  /** After a pause in typing, a longer text in `auto` shows the language it is in. */
  private async detectWhileTyping(): Promise<void> {
    const text = this.buffer.source.trim()
    if (text.length <= DETECT_MIN_LENGTH || this.state.userSetSourceLang) return
    if (this.buffer.sourceLang !== 'auto' && this.state.processed[this.textMode]) return
    const language = await this.detect(text.slice(0, DETECT_TYPING_SAMPLE))
    if (language && this.buffer.sourceLang !== language && !this.state.userSetSourceLang) {
      this.setSourceLang(language, true)
    }
  }

  /** The language of a sample, asked once per sample. */
  private async detect(sample: string): Promise<TranslatorLanguage | null> {
    if (this.detectCache?.sample === sample) return this.detectCache.language
    try {
      this.set({ detecting: true })
      const language = await this.api.detect({ text: sample, engine: this.engineFor()?.id })
      this.detectCache = { sample, language }
      return language
    } catch {
      return null
    } finally {
      this.set({ detecting: false })
    }
  }

  // --- Requests --------------------------------------------------------------------------------

  /**
   * Translates or rewrites the source sentence by sentence. With the settings unchanged and a
   * result shown, only the sentences that changed are redone (the rest keeps the user's edits);
   * nothing changed, nothing is sent.
   */
  async run(): Promise<void> {
    const mode = this.textMode
    const buffer = this.state[mode]
    const fullText = buffer.source.trim()
    if (!fullText || this.state.loading) return
    const sentences = splitIntoSentences(fullText)
    const processed = this.state.processed[mode]
    const settingsChanged =
      !processed ||
      processed.engine !== (this.engineFor()?.id ?? null) ||
      processed.style !== this.state.style ||
      processed.tone !== this.state.tone ||
      processed.formality !== this.state.formality ||
      processed.targetLang !== this.currentTarget() ||
      processed.sourceLang !== buffer.sourceLang ||
      processed.glossaries !== this.glossaryKey()

    let changed: number[] | null = null
    if (!settingsChanged && buffer.sourceSentences.length > 0) {
      changed = []
      const count = Math.max(sentences.length, buffer.sourceSentences.length)
      for (let index = 0; index < count; index++) {
        if (sentences[index]?.trim() !== buffer.sourceSentences[index]?.trim()) changed.push(index)
      }
      // Many changes at once redo everything; short texts are redone in parts more readily.
      const threshold = sentences.length < 10 ? 1 : 0.8
      if (
        changed.length > sentences.length * threshold ||
        Math.abs(sentences.length - buffer.sourceSentences.length) > 5
      ) {
        changed = null
      }
    }
    if (changed && changed.length === 0) return

    this.request?.abort()
    const controller = new AbortController()
    this.request = controller
    this.set({ loading: true, pendingSentences: changed, error: null })
    try {
      let sourceLang = buffer.sourceLang
      let targetLang = buffer.targetLang
      const sample = fullText.slice(0, TRANSLATOR_DETECT_SAMPLE_MAX)
      if (mode === 'rephrase') {
        if (sourceLang === 'auto') {
          sourceLang = (await this.detect(sample)) ?? 'de'
          this.setSourceLang(sourceLang, true)
        }
      } else if (sourceLang === 'auto') {
        const detected = await this.detect(sample)
        // HAWKI sends plain English on as it is detected, which its language list lacks: the
        // source stays "Automatisch" and the engine is told nothing more.
        if (detected && !detected.startsWith('en-')) {
          sourceLang = detected
          this.setSourceLang(detected, true)
          targetLang = this.state.translate.targetLang
        }
      }
      if (mode === 'translate' && sourceLang !== 'auto' && sourceLang === targetLang) {
        targetLang = alternativeTarget(sourceLang)
        this.patchBuffer({ targetLang }, 'translate')
      }

      const engine = this.engineFor()?.id
      const common = {
        text: sentences,
        engine,
        formality: this.state.formality,
        style: this.state.style,
        tone: this.state.tone,
        glossaryIds: this.state.glossaryIds
      }
      const results =
        mode === 'rephrase'
          ? (
              await this.api.rephrase(
                { ...common, language: sourceLang === 'auto' ? null : sourceLang },
                controller.signal
              )
            ).text
          : (
              await this.api.translate(
                {
                  ...common,
                  source: sourceLang === 'auto' ? null : sourceLang,
                  target: targetLang
                },
                controller.signal
              )
            ).text
      if (controller.signal.aborted) return

      const current = this.state[mode]
      let target: string[]
      if (changed !== null && current.sourceSentences.length > 0) {
        // The user's own sentences after the last source sentence stay where they are.
        const extra =
          current.targetSentences.length > current.sourceSentences.length
            ? current.targetSentences.slice(current.sourceSentences.length)
            : []
        target = sentences.map((sentence, index) => {
          const own = current.targetSentences[index]
          const next =
            changed!.includes(index) || own === undefined ? (results[index] ?? own ?? '') : own
          return withTrailingWhitespace(next, sentence)
        })
        target = target.concat(extra)
      } else {
        target = results.map((result, index) =>
          withTrailingWhitespace(result, sentences[index] ?? '')
        )
      }
      this.patchBuffer(
        {
          targetSentences: target,
          sourceSentences: sentences,
          baselineTargetSentences: [...target],
          lastSourceText: fullText,
          sourceLang: this.state[mode].sourceLang
        },
        mode
      )
      this.set({
        processed: {
          ...this.state.processed,
          [mode]: this.snapshot(
            fullText,
            this.state[mode].sourceLang,
            mode === 'rephrase' ? (sourceLang === 'auto' ? null : sourceLang) : targetLang
          )
        }
      })
      this.suggestionCache.clear()
    } catch (error) {
      if (controller.signal.aborted) return
      this.showError(error)
    } finally {
      if (this.request === controller) {
        this.request = null
        this.set({ loading: false, pendingSentences: null })
      }
    }
  }

  private showError(error: unknown): void {
    this.clock.clearTimeout(this.errorTimer)
    this.set({ error })
    this.errorTimer = this.clock.setTimeout(() => this.set({ error: null }), TEXT_ERROR_MS)
  }

  /** Live editing: a finished sentence goes out at once, anything else after a pause. */
  private scheduleLive(value: string): void {
    if (!this.liveActive || !value.trim()) return
    const processedText = this.state.processed[this.textMode]?.text ?? ''
    this.clock.clearTimeout(this.liveTimer)
    if (
      completeSentenceCount(value) > completeSentenceCount(processedText) &&
      !this.state.loading
    ) {
      void this.run()
      return
    }
    this.liveTimer = this.clock.setTimeout(() => {
      const current = this.buffer.source
      if (!current.trim()) return
      if (this.state.loading) this.scheduleLive(current)
      else if (current.trim() !== (this.state.processed[this.textMode]?.text ?? '')) void this.run()
    }, TYPING_PAUSE_MS)
  }

  /** A changed setting redoes the shown text at once while live editing is on. */
  private runLiveNow(): void {
    if (this.liveActive && this.buffer.source.trim() && this.state.mode !== 'documents') {
      void this.run()
    }
  }

  // --- Settings --------------------------------------------------------------------------------

  selectEngine(engine: TranslatorEngineId): void {
    this.set({ engine })
  }

  /** Style, tone and formality exclude each other: choosing one resets the other two. */
  selectStyle(style: RephraseStyle): void {
    this.set({ style, tone: null, formality: 'default' })
    this.runLiveNow()
  }

  selectTone(tone: RephraseTone): void {
    this.set({ tone, style: null, formality: 'default' })
    this.runLiveNow()
  }

  selectFormality(formality: Exclude<TranslatorFormality, 'default'>): void {
    this.set({ formality, style: null, tone: null })
    this.runLiveNow()
  }

  resetStyle(): void {
    this.set({ style: null, tone: null, formality: 'default' })
    this.runLiveNow()
  }

  setLive(live: boolean): void {
    this.set({ live })
    this.runLiveNow()
  }

  setShowChanges(showChanges: boolean): void {
    this.set({ showChanges })
  }

  setAiContextMenu(aiContextMenu: boolean): void {
    this.set({ aiContextMenu })
  }

  setFormatting(formatting: boolean): void {
    this.set({ formatting })
  }

  setGlossaries(glossaryIds: string[]): void {
    this.set({ glossaryIds })
  }

  setDocTargetLang(docTargetLang: TranslatorLanguage): void {
    this.set({ docTargetLang })
  }

  closeNotice(): void {
    this.set({ noticeClosed: true })
  }

  setWebSearch(webSearch: boolean): void {
    this.set({ webSearch })
  }

  /** The editor's document, as HTML and as Markdown. */
  setCreateHtml(createHtml: string, createText: string): void {
    if (createHtml !== this.state.createHtml || createText !== this.state.createText)
      this.set({ createHtml, createText })
  }

  setCreateMarkdown(createMarkdown: string | null): void {
    if (createMarkdown !== this.state.createMarkdown) this.set({ createMarkdown })
  }

  setCreateCount(createCount: string | null): void {
    if (createCount !== this.state.createCount) this.set({ createCount })
  }

  // --- Modes -----------------------------------------------------------------------------------

  /**
   * Switches the mode; each text mode keeps its own text and result. `initialText` starts the
   * new mode with that text instead.
   */
  switchMode(mode: TranslatorMode, initialText: string | null = null): void {
    if (mode === this.state.mode && initialText === null) return
    this.suggestionCache.clear()
    if (initialText !== null && (mode === 'translate' || mode === 'rephrase')) {
      this.set({
        [mode]: {
          ...this.state[mode],
          source: initialText,
          sourceSentences: [],
          targetSentences: [],
          baselineTargetSentences: [],
          lastSourceText: '',
          outputText: null
        },
        processed: { ...this.state.processed, [mode]: null }
      } as Partial<TranslatorState>)
    }
    this.set({ mode, error: null })
    if (initialText !== null && initialText.trim().length > DETECT_MIN_LENGTH)
      this.scheduleDetection()
  }

  /**
   * The result as the text of the other text mode, processed right away. HAWKI sets the source
   * to the translation's target language both ways, as if the user had chosen it: from the
   * translation into rewriting, and from rewriting back into translating.
   */
  private transferTarget(mode: TextMode): void {
    const text = this.outputText
    if (!text.trim()) return
    const language = this.state.translate.targetLang
    this.switchMode(mode, text)
    this.set({ userSetSourceLang: true })
    this.patchBuffer({ sourceLang: language }, mode)
    this.preventSameLanguage('source')
    void this.run()
  }

  /** The translation as the text to rewrite. */
  improveTarget(): void {
    this.transferTarget('rephrase')
  }

  /** The rewritten text as the text to translate. */
  translateTarget(): void {
    this.transferTarget('translate')
  }

  // --- Sentences of the result -----------------------------------------------------------------

  /** Which source (rewriting) or original result (translating) sentence each shown one is. */
  mapping(): number[] {
    const buffer = this.buffer
    return sentenceMapping(
      buffer.targetSentences,
      this.textMode === 'rephrase' ? buffer.sourceSentences : buffer.baselineTargetSentences
    )
  }

  /** The source sentence a shown sentence belongs to; `null` for one the user added. */
  sourceIndexOf(index: number): number | null {
    const mapped = sentenceMapping(
      this.buffer.targetSentences,
      this.buffer.baselineTargetSentences
    )[index]
    return mapped === undefined || mapped === -1 ? null : mapped
  }

  private originalOf(index: number): string | undefined {
    const buffer = this.buffer
    const baseline =
      this.textMode === 'rephrase' ? buffer.sourceSentences : buffer.baselineTargetSentences
    const mapped = this.mapping()[index]
    return mapped === undefined || mapped === -1 ? undefined : baseline[mapped]
  }

  /** Whether a shown sentence differs from where it came from, so undo has something to do. */
  isSentenceChanged(index: number): boolean {
    const original = this.originalOf(index)
    const current = this.buffer.targetSentences[index]
    return original !== undefined && current !== undefined && original !== current
  }

  undoSentence(index: number): void {
    const original = this.originalOf(index)
    if (original === undefined) return
    const targetSentences = [...this.buffer.targetSentences]
    // The whitespace after the sentence stays, so it does not run into the next one.
    const trailing = /\s*$/.exec(targetSentences[index] ?? '')?.[0] ?? ''
    targetSentences[index] = original.trimEnd() + trailing
    this.patchBuffer({ targetSentences })
  }

  private sentenceSource(index: number): string {
    const buffer = this.buffer
    return (
      (this.textMode === 'translate'
        ? buffer.targetSentences[index]
        : buffer.sourceSentences[index]) ??
      buffer.targetSentences[index] ??
      ''
    )
  }

  /** What the list of suggestions starts with: the sentence or the word as it is. */
  suggestionOriginal(target: SuggestionTarget): string {
    if (target.kind === 'word') {
      return (
        sentenceTokens(this.buffer.targetSentences[target.index] ?? '')[target.tokenIndex ?? -1] ??
        ''
      )
    }
    return this.sentenceSource(target.index)
  }

  private cacheKey(target: SuggestionTarget): string {
    return target.kind === 'word' ? `${target.index}-${target.tokenIndex}` : String(target.index)
  }

  cachedSuggestions(target: SuggestionTarget): string[] | undefined {
    return this.suggestionCache.get(this.cacheKey(target))
  }

  /**
   * Suggestions for a sentence (other wordings) or a word (other words in its sentence); `more`
   * asks for further ones on top of those shown.
   */
  async loadSuggestions(
    target: SuggestionTarget,
    more = false,
    signal?: AbortSignal
  ): Promise<string[]> {
    const key = this.cacheKey(target)
    const known = this.suggestionCache.get(key) ?? []
    if (known.length > 0 && !more) return known
    const original = this.suggestionOriginal(target)
    const language = this.currentTarget()
    let request: TranslatorSuggestRequest
    if (target.kind === 'word') {
      const tokens = sentenceTokens(this.buffer.targetSentences[target.index] ?? '')
      if (target.tokenIndex !== null && tokens[target.tokenIndex] !== undefined) {
        tokens[target.tokenIndex] = `[[TARGET]]${tokens[target.tokenIndex]}[[TARGET]]`
      }
      request = {
        kind: 'synonyms',
        text: original,
        context: tokens.join(''),
        language: language as TranslatorLanguage | null,
        engine: this.engineFor()?.id,
        exclusions: known
      }
    } else {
      request = {
        kind: 'alternatives',
        text: original,
        language: language as TranslatorLanguage | null,
        engine: this.engineFor()?.id,
        formality: this.state.formality,
        style: this.state.style,
        tone: this.state.tone,
        exclusions: known
      }
    }
    const suggestions = await this.api.suggest(request, signal)
    const list = [...known, ...suggestions.filter((suggestion) => !known.includes(suggestion))]
    this.suggestionCache.set(key, list)
    return list
  }

  /**
   * Puts a suggestion into the result: a sentence in place of the sentence, a word in place of
   * the word, after which the sentence is corrected to fit it.
   */
  async applySuggestion(target: SuggestionTarget, text: string): Promise<void> {
    const buffer = this.buffer
    const targetSentences = [...buffer.targetSentences]
    if (target.kind === 'word') {
      const original = targetSentences[target.index] ?? ''
      const tokens = sentenceTokens(original)
      if (target.tokenIndex === null || tokens[target.tokenIndex] === undefined) return
      tokens[target.tokenIndex] = text.replace(/\[\[TARGET\]\]/g, '')
      const sentence = tokens.join('')
      const trailing = /[\s\r\n]+$/.exec(sentence)?.[0] ?? ''
      targetSentences[target.index] = sentence
      this.patchBuffer({ targetSentences })
      this.set({ pendingSentences: [target.index] })
      try {
        const [corrected] = await this.api.suggest({
          kind: 'correction',
          text: sentence.trim(),
          context: original,
          language: this.currentTarget() as TranslatorLanguage | null,
          engine: this.engineFor()?.id
        })
        if (corrected) {
          const next = [...this.buffer.targetSentences]
          next[target.index] = corrected.replace(/[\s\r\n]+$/, '') + trailing
          this.patchBuffer({ targetSentences: next })
        }
      } catch {
        // The word is in; the correction is a nicety.
      } finally {
        this.set({ pendingSentences: null })
      }
      return
    }
    const current = targetSentences[target.index] ?? buffer.sourceSentences[target.index] ?? ''
    const trailing = /[\s\r\n]+$/.exec(current)?.[0] ?? ''
    targetSentences[target.index] = text.replace(/[\s\r\n]+$/, '') + trailing
    this.patchBuffer({ targetSentences })
  }

  /**
   * A sentence the user added to the result goes into the source, after the source sentence of
   * the result sentence before it; translating, it is translated back into the source language.
   */
  async pushToSource(index: number): Promise<void> {
    const mode = this.textMode
    const buffer = this.buffer
    const sentence = buffer.targetSentences[index]
    if (!sentence) return
    const mapping = sentenceMapping(buffer.targetSentences, buffer.baselineTargetSentences)
    let after = -1
    for (let pointer = index - 1; pointer >= 0; pointer--) {
      if ((mapping[pointer] ?? -1) !== -1) {
        after = mapping[pointer]!
        break
      }
    }
    const trailing = /[\s\n\r]+$/.exec(sentence)?.[0] ?? ' '
    const punctuated = (text: string): string =>
      (/[.!?]+$/.test(text.trim()) ? text.trim() : `${text.trim()}.`) + trailing
    const insertAt = after === -1 ? 0 : after + 1
    const sources = splitIntoSentences(buffer.source)
    const leading =
      insertAt > 0 && sources[insertAt - 1] && !/[\s\n\r]$/.test(sources[insertAt - 1]!) ? ' ' : ''
    const insert = (text: string): string[] => {
      const next = [...sources]
      next.splice(insertAt, 0, leading + text)
      return next
    }
    const literal = punctuated(sentence)
    const finish = (text: string): void => {
      const nextSources = insert(text)
      const source = nextSources.join('')
      const baseline = [...this.state[mode].baselineTargetSentences]
      if (mode === 'translate') baseline.splice(insertAt, 0, `${sentence.trim()}${trailing}`)
      this.patchBuffer(
        {
          source,
          sourceSentences: splitIntoSentences(source.trim()),
          baselineTargetSentences:
            mode === 'translate' ? baseline : this.state[mode].baselineTargetSentences
        },
        mode
      )
      const processed = this.state.processed[mode]
      if (processed) {
        this.set({
          processed: { ...this.state.processed, [mode]: { ...processed, text: source.trim() } }
        })
      }
    }
    if (mode === 'rephrase') {
      finish(literal)
      return
    }
    this.patchBuffer({ source: insert(literal).join('') }, mode)
    this.set({ pendingSentences: [index] })
    try {
      const { sourceLang, targetLang } = this.state.translate
      const response = await this.api.translate({
        text: [sentence],
        source: targetLang,
        target: sourceLang === 'auto' ? 'de' : sourceLang,
        engine: this.engineFor()?.id
      })
      finish(punctuated(response.text[0] ?? sentence))
    } catch {
      finish(literal)
    } finally {
      this.set({ pendingSentences: null })
    }
  }
}
