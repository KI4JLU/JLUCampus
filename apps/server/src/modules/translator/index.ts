import {
  parseGlossaryCsv,
  rephraseRequestSchema,
  rephraseResponseSchema,
  translateRequestSchema,
  translateResponseSchema,
  translatorComponentConfigSchema,
  translatorComposeRequestSchema,
  translatorComposeResponseSchema,
  translatorDetectRequestSchema,
  translatorDetectResponseSchema,
  translatorEngineListSchema,
  translatorGlossaryImportSchema,
  translatorGlossaryInputSchema,
  translatorGlossaryListSchema,
  translatorGlossaryPatchSchema,
  translatorModelListSchema,
  translatorModelsRequestSchema,
  translatorPythonRequestSchema,
  translatorPythonResponseSchema,
  translatorDocumentExtension,
  translatorDocumentListSchema,
  translatorDocumentUploadSchema,
  translatorSuggestRequestSchema,
  translatorSuggestResponseSchema,
  TRANSLATOR_DOCUMENT_ACTIVE_MAX,
  TRANSLATOR_DOCUMENT_FILENAME_MAX,
  TRANSLATOR_DOCUMENT_MAX_BYTES,
  TRANSLATOR_DOCUMENT_TOO_LARGE,
  TRANSLATOR_DOCUMENT_UPLOADS_PER_MINUTE,
  TRANSLATOR_GLOSSARY_IMPORT_MAX_BYTES,
  TRANSLATOR_GLOSSARY_IMPORT_TOO_LARGE,
  TRANSLATOR_GLOSSARY_ROLES,
  translatorGlossaryEntrySchema,
  TRANSLATOR_REQUESTS_PER_MINUTE,
  type TranslatorLanguage
} from '@justcampus/shared'
import { and, eq, gt, isNull } from 'drizzle-orm'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import { getAccess, requireFeature } from '../../access.js'
import { ApiError, parseBody, validationIssues } from '../../api.js'
import { db } from '../../db/index.js'
import { translatorDocument, translatorGlossary } from '../../db/schema.js'
import { env } from '../../env.js'
import { encryptSecret } from '../../secrets.js'
import { getModuleRuntime } from '../context.js'
import type { AppEnvironment, ModuleRuntime, ServerModule } from '../types.js'
import {
  createDeepLGlossary,
  deleteDeepLGlossary,
  DeepLRefusedError,
  detectWithDeepL,
  rephraseWithDeepL,
  sweepDeepLGlossaries,
  translateWithDeepL,
  uploadDocument
} from './deepl.js'
import {
  activeDocumentCount,
  documentExpiry,
  findDocument,
  findDocumentResult,
  listDocuments,
  pollDocument,
  publicDocument,
  recoverErrorMessage,
  rememberJobGlossary,
  resultFilename,
  startDocumentWorker
} from './documents.js'
import { assistantModel, listEngines, resolveDefaultEngine, resolveEngine } from './engines.js'
import {
  canEditGlossary,
  findGlossary,
  glossaryDetail,
  glossaryEntries,
  glossaryPairs,
  glossaryRights,
  glossaryTerms,
  glossaryViewer,
  insertGlossary,
  listGlossaries,
  newGlossaryNameError,
  type GlossaryRow,
  type GlossaryViewer
} from './glossaries.js'
import {
  composeWithLlm,
  detectWithLlm,
  listLlmModels,
  rephraseWithLlm,
  suggestWithLlm,
  translateWithLlm,
  type LlmTarget
} from './llm.js'
import { PythonUnavailableError, runPython, trimCode } from './python.js'
import { requestThrottle, throttled } from './throttle.js'
import { readLinkedPages } from './web.js'

export const translatorApp = new Hono<AppEnvironment>()

for (const [paths, feature] of [
  [['/documents', '/documents/*'], 'translator.documents'],
  [['/rephrase'], 'translator.rephrase'],
  [['/compose', '/execute-python'], 'translator.compose'],
  [['/glossaries', '/glossaries/*'], 'translator.glossaries']
] as const) {
  for (const path of paths) translatorApp.use(path, requireFeature(feature))
}

// Reservations cover overlapping requests in this Node process. Multiple server processes need a shared lock.
const uploadsInFlight = new Map<string, number>()

function upstreamSignal(signal: AbortSignal, timeoutMs = 60_000): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
}

/** A text of up to 50,000 characters takes the model a while. */
const LONG_REQUEST_MS = 180_000

async function viewer(context: Context<AppEnvironment>): Promise<GlossaryViewer> {
  const { user } = context.get('session')
  return glossaryViewer(user.id, (await getAccess(context)).isAdmin)
}

function llmTarget(runtime: ModuleRuntime<'translator'>, model: string): LlmTarget {
  return { baseUrl: runtime.config.llmBaseUrl!, apiKey: runtime.secrets.llmApiKey, model }
}

/** Upstream failures become `502 module_unavailable`; the route's own errors stay. */
async function upstream<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof ApiError) throw error
    console.error('Translator upstream request failed', error)
    throw new ApiError(502, 'module_unavailable', 'Translation service is unavailable')
  }
}

translatorApp.get('/engines', async (context) => {
  const { config, secrets } = getModuleRuntime(context, 'translator')
  const engines = listEngines(config, secrets)
  return context.json(
    translatorEngineListSchema.parse({
      engines,
      defaultEngine: resolveDefaultEngine(config, engines),
      documents: Boolean(
        config.documentsEnabled &&
        secrets.deeplApiKey &&
        (await getAccess(context)).features.has('translator.documents')
      ),
      llmProvider: config.llmProviderName
    })
  )
})

/** Temporary DeepL glossaries older than this are left over and removed. */
const STALE_GLOSSARY_MS = 2 * 60 * 60 * 1000
let lastGlossarySweep = 0

/** Removes left-over temporary glossaries, at most every half hour. */
async function sweepStaleGlossaries(apiUrl: string | null, apiKey: string): Promise<void> {
  if (Date.now() - lastGlossarySweep < 30 * 60 * 1000) return
  lastGlossarySweep = Date.now()
  try {
    await sweepDeepLGlossaries(apiUrl, apiKey, STALE_GLOSSARY_MS)
  } catch (error) {
    console.error('Sweeping temporary DeepL glossaries failed', error)
  }
}

function documentsRuntime(
  context: Parameters<typeof getModuleRuntime>[0]
): ModuleRuntime<'translator'> {
  const runtime = getModuleRuntime(context, 'translator')
  if (!runtime.config.documentsEnabled || !runtime.secrets.deeplApiKey) {
    throw new ApiError(404, 'not_found', 'Documents are not available')
  }
  return runtime
}

function documentId(value: string): string {
  return z.uuid().safeParse(value).success ? value : '00000000-0000-0000-0000-000000000000'
}

function validation(path: string, message: string): never {
  throw new ApiError(400, 'validation', 'Request validation failed', [{ path: [path], message }])
}

// Unavailable documents answer 404 before anything else looks at the request, the body limit too.
translatorApp.use('/documents', async (context, next) => {
  documentsRuntime(context)
  await next()
})
translatorApp.use('/documents/*', async (context, next) => {
  documentsRuntime(context)
  await next()
})

// HAWKI's throttle: translating, rewriting, detecting, the AI editor, Python runs and document
// uploads add to one count per user and minute, which uploads may only take to ten.
const throttle = requestThrottle()
const textThrottled = throttled(throttle, TRANSLATOR_REQUESTS_PER_MINUTE)
for (const path of [
  '/translate',
  '/rephrase',
  '/detect',
  '/suggest',
  '/compose',
  '/execute-python'
]) {
  translatorApp.post(path, textThrottled)
}
// Counted before the body is read, so a file over the limit counts as in HAWKI.
translatorApp.post('/documents', throttled(throttle, TRANSLATOR_DOCUMENT_UPLOADS_PER_MINUTE))

// A body far over the limit is refused unread, with the same issue as a file just over it.
translatorApp.use(
  '/documents',
  bodyLimit({
    maxSize: TRANSLATOR_DOCUMENT_MAX_BYTES + 64 * 1024,
    onError: () => validation('file', TRANSLATOR_DOCUMENT_TOO_LARGE)
  })
)

translatorApp.get('/documents', async (context) => {
  const { componentId } = documentsRuntime(context)
  const rows = await listDocuments(componentId, context.get('session').user.id)
  return context.json(translatorDocumentListSchema.parse({ documents: rows.map(publicDocument) }))
})

translatorApp.post('/documents', async (context) => {
  const { componentId, config, secrets } = documentsRuntime(context)
  const userId = context.get('session').user.id
  // Reserved before the body is read, so parallel uploads cannot pile up 20 MB bodies unchecked.
  const inFlight = uploadsInFlight.get(userId) ?? 0
  uploadsInFlight.set(userId, inFlight + 1)
  try {
    // Only jobs running at once are capped; as in HAWKI there is no daily quota.
    if ((await activeDocumentCount(userId)) + inFlight >= TRANSLATOR_DOCUMENT_ACTIVE_MAX) {
      throw new ApiError(429, 'rate_limited', 'Document upload limit reached')
    }
    let body: FormData
    try {
      body = await context.req.raw.formData()
    } catch {
      return validation('file', 'Expected multipart form data')
    }
    const uploaded = body.get('file')
    if (!(uploaded instanceof File) || uploaded.size === 0)
      return validation('file', 'Select a non-empty file')
    const filename = basename(uploaded.name.replaceAll('\\', '/')).trim()
    if (!filename || filename.length > TRANSLATOR_DOCUMENT_FILENAME_MAX)
      return validation('file', 'Invalid filename')
    if (!translatorDocumentExtension(filename)) return validation('file', 'Unsupported file type')
    if (uploaded.size > TRANSLATOR_DOCUMENT_MAX_BYTES)
      return validation('file', TRANSLATOR_DOCUMENT_TOO_LARGE)
    const fields = {
      ...Object.fromEntries(
        ['source', 'target', 'formality'].map((key) => [key, body.get(key) ?? undefined])
      ),
      glossaryIds: body.getAll('glossaryId')
    }
    const parsed = translatorDocumentUploadSchema.safeParse(fields)
    if (!parsed.success)
      throw new ApiError(
        400,
        'validation',
        'Request validation failed',
        validationIssues(parsed.error)
      )
    const file = new File([uploaded], filename, { type: uploaded.type })
    const signal = upstreamSignal(context.req.raw.signal)
    // A glossary needs a source language at DeepL. As in HAWKI, a document whose language is
    // detected ("Automatisch") is translated without the glossaries.
    const source = parsed.data.source
    const entries = source
      ? await glossaryEntries(parsed.data.glossaryIds, componentId, () => viewer(context))
      : []
    let glossaryId: string | null = null
    let remote: Awaited<ReturnType<typeof uploadDocument>>
    try {
      if (entries.length > 0) {
        await sweepStaleGlossaries(config.deeplApiUrl, secrets.deeplApiKey!)
        glossaryId = await createDeepLGlossary(
          glossaryPairs(entries, source, parsed.data.target),
          source,
          parsed.data.target,
          config.deeplApiUrl,
          secrets.deeplApiKey!,
          signal
        )
      }
      remote = await uploadDocument(
        file,
        { ...parsed.data, glossaryId },
        config.deeplApiUrl,
        secrets.deeplApiKey!,
        signal
      )
    } catch (error) {
      if (glossaryId) void deleteDeepLGlossary(glossaryId, config.deeplApiUrl, secrets.deeplApiKey!)
      // DeepL's own words say what is wrong with the file; the page, as HAWKI's, shows its
      // general message instead, but they are kept for whoever reads the answer.
      if (error instanceof DeepLRefusedError && error.detail) {
        throw new ApiError(400, 'validation', 'DeepL refused the document', [
          { path: ['file', 'deepl'], message: error.detail }
        ])
      }
      throw new ApiError(502, 'module_unavailable', 'Translation service is unavailable')
    }
    const id = randomUUID()
    const [row] = await db
      .insert(translatorDocument)
      .values({
        id,
        componentId,
        userId,
        filename,
        size: uploaded.size,
        source,
        target: parsed.data.target,
        formality: parsed.data.formality,
        deeplDocumentId: remote.document_id,
        deeplDocumentKey: encryptSecret(
          remote.document_key,
          env.COMPONENT_SECRETS_KEY,
          `translator_document:${id}`,
          'document_key'
        ),
        expiresAt: documentExpiry()
      })
      .returning()
    if (glossaryId) rememberJobGlossary(id, glossaryId, config.deeplApiUrl, secrets.deeplApiKey!)
    return context.json(publicDocument({ ...row!, resultSize: null }), 201)
  } finally {
    const remaining = (uploadsInFlight.get(userId) ?? 1) - 1
    if (remaining === 0) uploadsInFlight.delete(userId)
    else uploadsInFlight.set(userId, remaining)
  }
})

translatorApp.get('/documents/:id/download', async (context) => {
  const { componentId } = documentsRuntime(context)
  const row = await findDocument(
    documentId(context.req.param('id')),
    componentId,
    context.get('session').user.id
  )
  if (!row) throw new ApiError(404, 'not_found', 'Document not found')
  const stored =
    row.status === 'done'
      ? await findDocumentResult(row.id, componentId, context.get('session').user.id)
      : undefined
  if (!stored?.result) throw new ApiError(409, 'conflict', 'Document is not ready')
  const filename = resultFilename(row.filename, row.target)
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return new Response(new Uint8Array(stored.result), {
    headers: {
      'Content-Type': stored.resultContentType ?? 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store'
    }
  })
})

translatorApp.get('/documents/:id', async (context) => {
  const { componentId, config, secrets } = documentsRuntime(context)
  const id = documentId(context.req.param('id'))
  let row = await findDocument(id, componentId, context.get('session').user.id)
  if (!row) throw new ApiError(404, 'not_found', 'Document not found')
  if (row.status === 'queued' || row.status === 'translating') {
    try {
      await pollDocument(id, config.deeplApiUrl, secrets.deeplApiKey!)
    } catch (error) {
      console.error('Translator document poll failed', id, error)
    }
    row = await findDocument(id, componentId, context.get('session').user.id)
    if (!row) throw new ApiError(404, 'not_found', 'Document not found')
  }
  row = await recoverErrorMessage(row, config.deeplApiUrl, secrets.deeplApiKey!)
  return context.json(publicDocument(row))
})

translatorApp.delete('/documents/:id', async (context) => {
  const { componentId } = documentsRuntime(context)
  const [deleted] = await db
    .update(translatorDocument)
    .set({ deletedAt: new Date(), result: null, resultContentType: null })
    .where(
      and(
        eq(translatorDocument.id, documentId(context.req.param('id'))),
        eq(translatorDocument.componentId, componentId),
        eq(translatorDocument.userId, context.get('session').user.id),
        isNull(translatorDocument.deletedAt),
        gt(translatorDocument.expiresAt, new Date())
      )
    )
    .returning({ id: translatorDocument.id })
  if (!deleted) throw new ApiError(404, 'not_found', 'Document not found')
  return context.body(null, 204)
})

translatorApp.post('/translate', async (context) => {
  const input = await parseBody(context, translateRequestSchema)
  const runtime = getModuleRuntime(context, 'translator')
  const { config, secrets, componentId } = runtime
  const engine = resolveEngine(input.engine, config, secrets)
  const entries = await glossaryEntries(input.glossaryIds, componentId, () => viewer(context))
  const glossary = glossaryPairs(entries, input.source, input.target)
  const result = await upstream(async () => {
    const signal = upstreamSignal(context.req.raw.signal, LONG_REQUEST_MS)
    return engine.kind === 'deepl'
      ? translateWithDeepL(input, config.deeplApiUrl, secrets.deeplApiKey!, signal, glossary)
      : translateWithLlm(input, llmTarget(runtime, engine.model), glossary, signal)
  })
  return context.json(translateResponseSchema.parse(result))
})

translatorApp.post('/rephrase', async (context) => {
  const input = await parseBody(context, rephraseRequestSchema)
  const runtime = getModuleRuntime(context, 'translator')
  const { config, secrets, componentId } = runtime
  const engine = resolveEngine(input.engine, config, secrets)
  const entries = await glossaryEntries(input.glossaryIds, componentId, () => viewer(context))
  const result = await upstream(async () => {
    const signal = upstreamSignal(context.req.raw.signal, LONG_REQUEST_MS)
    return engine.kind === 'deepl'
      ? rephraseWithDeepL(input, config.deeplApiUrl, secrets.deeplApiKey!, signal)
      : rephraseWithLlm(
          input,
          llmTarget(runtime, engine.model),
          glossaryTerms(entries, input.language),
          signal
        )
  })
  return context.json(rephraseResponseSchema.parse(result))
})

translatorApp.post('/detect', async (context) => {
  const input = await parseBody(context, translatorDetectRequestSchema)
  const runtime = getModuleRuntime(context, 'translator')
  const { config, secrets } = runtime
  // Detection is quick and cheap with a model; DeepL only does it with a translation.
  const model = assistantModel(input.engine, config, secrets)
  if (!model && !secrets.deeplApiKey) {
    throw new ApiError(502, 'module_unavailable', 'No translation engine is configured')
  }
  const language: TranslatorLanguage | null = await upstream(async () => {
    const signal = upstreamSignal(context.req.raw.signal, 30_000)
    return model
      ? detectWithLlm(input.text, llmTarget(runtime, model), signal)
      : detectWithDeepL(input.text, config.deeplApiUrl, secrets.deeplApiKey!, signal)
  })
  return context.json(translatorDetectResponseSchema.parse({ language }))
})

translatorApp.post('/suggest', async (context) => {
  const input = await parseBody(context, translatorSuggestRequestSchema)
  const runtime = getModuleRuntime(context, 'translator')
  const { config, secrets } = runtime
  const model = assistantModel(input.engine, config, secrets)
  if (!model) {
    // Without a model, DeepL Write offers its one improvement of a sentence.
    if (input.kind !== 'alternatives' || !secrets.deeplApiKey) {
      throw new ApiError(400, 'validation', 'Suggestions need an AI model', [
        { path: ['engine'], message: 'Select an AI model' }
      ])
    }
    const result = await upstream(() =>
      rephraseWithDeepL(
        { ...input, text: [input.text], glossaryIds: [] },
        config.deeplApiUrl,
        secrets.deeplApiKey!,
        upstreamSignal(context.req.raw.signal)
      )
    )
    const suggestions = result.text.filter(
      (text) => text.trim() && text.trim() !== input.text && !input.exclusions.includes(text.trim())
    )
    return context.json(translatorSuggestResponseSchema.parse({ suggestions }))
  }
  const suggestions = await upstream(() =>
    suggestWithLlm(input, llmTarget(runtime, model), upstreamSignal(context.req.raw.signal))
  )
  return context.json(translatorSuggestResponseSchema.parse({ suggestions }))
})

translatorApp.post('/compose', async (context) => {
  const input = await parseBody(context, translatorComposeRequestSchema)
  const runtime = getModuleRuntime(context, 'translator')
  const engine = resolveEngine(input.engine, runtime.config, runtime.secrets)
  if (engine.kind !== 'llm') {
    throw new ApiError(400, 'validation', 'DeepL cannot compose text', [
      { path: ['engine'], message: 'Select an AI model' }
    ])
  }
  // HAWKI's web search: the pages the instruction links to are read first.
  const pages = input.webSearch ? await readLinkedPages(input.instruction) : []
  const text = await upstream(() =>
    composeWithLlm(
      input,
      llmTarget(runtime, engine.model),
      upstreamSignal(context.req.raw.signal, LONG_REQUEST_MS),
      pages
    )
  )
  return context.json(translatorComposeResponseSchema.parse({ text }))
})

translatorApp.post('/execute-python', async (context) => {
  getModuleRuntime(context, 'translator')
  const code = trimCode((await parseBody(context, translatorPythonRequestSchema)).code)
  // HAWKI's answer to a block without code, which its editor shows as it is.
  if (!code) {
    throw new ApiError(400, 'validation', 'validation.required', [
      { path: ['code'], message: 'validation.required' }
    ])
  }
  try {
    const answer = await runPython(code, {
      command: env.PYTHON_SANDBOX_DOCKER,
      image: env.PYTHON_SANDBOX_IMAGE,
      runtime: env.PYTHON_SANDBOX_RUNTIME
    })
    return context.json(translatorPythonResponseSchema.parse(answer))
  } catch (error) {
    if (!(error instanceof PythonUnavailableError)) throw error
    console.error('Python sandbox is unavailable', error)
    throw new ApiError(502, 'module_unavailable', 'Python cannot be run')
  }
})

function glossaryId(value: string): string {
  return z.uuid().safeParse(value).success ? value : '00000000-0000-0000-0000-000000000000'
}

translatorApp.get('/glossaries', async (context) => {
  const { componentId } = getModuleRuntime(context, 'translator')
  const who = await viewer(context)
  return context.json(
    translatorGlossaryListSchema.parse({
      glossaries: await listGlossaries(componentId, who),
      roles: [...TRANSLATOR_GLOSSARY_ROLES]
    })
  )
})

/** Refuses a new glossary's name too long for HAWKI, in HAWKI's words (see `newGlossaryNameError`). */
function checkNewGlossaryName(...args: Parameters<typeof newGlossaryNameError>): void {
  const message = newGlossaryNameError(...args)
  if (message) throw new ApiError(400, 'validation', message, [{ path: ['name'], message }])
}

translatorApp.post('/glossaries', async (context) => {
  const input = await parseBody(context, translatorGlossaryInputSchema)
  const { componentId } = getModuleRuntime(context, 'translator')
  const who = await viewer(context)
  checkNewGlossaryName('create', input, who.userId)
  const row = await insertGlossary({ componentId, userId: who.userId, ...input })
  const created = await findGlossary(row.id, componentId, who)
  return context.json(glossaryDetail(created!, who), 201)
})

translatorApp.use(
  '/glossaries/import',
  bodyLimit({
    maxSize: TRANSLATOR_GLOSSARY_IMPORT_MAX_BYTES + 64 * 1024,
    onError: () => {
      throw new ApiError(400, 'validation', TRANSLATOR_GLOSSARY_IMPORT_TOO_LARGE, [
        { path: ['file'], message: TRANSLATOR_GLOSSARY_IMPORT_TOO_LARGE }
      ])
    }
  })
)

translatorApp.post('/glossaries/import', async (context) => {
  const { componentId } = getModuleRuntime(context, 'translator')
  const who = await viewer(context)
  let body: FormData
  try {
    body = await context.req.raw.formData()
  } catch {
    return validation('file', 'Expected multipart form data')
  }
  const parsed = translatorGlossaryImportSchema.safeParse(
    Object.fromEntries(
      ['name', 'description', 'sourceLanguage', 'targetLanguage'].map((key) => [
        key,
        body.get(key) ?? undefined
      ])
    )
  )
  if (!parsed.success) {
    throw new ApiError(
      400,
      'validation',
      'Request validation failed',
      validationIssues(parsed.error)
    )
  }
  const file = body.get('file')
  if (!(file instanceof File) || file.size === 0) return validation('file', 'Select a CSV file')
  if (file.size > TRANSLATOR_GLOSSARY_IMPORT_MAX_BYTES)
    return validation('file', TRANSLATOR_GLOSSARY_IMPORT_TOO_LARGE)
  const pairs = parseGlossaryCsv(await file.text())
  if (!pairs) return validation('file', 'Expected two columns: source term, target term')
  // Every pair counts, as in HAWKI; a term too long for HAWKI's column fails the import there too.
  const entries = z.array(translatorGlossaryEntrySchema).safeParse(
    pairs.map((pair) => ({
      sourceLanguage: parsed.data.sourceLanguage,
      sourceTerm: pair.source,
      targetLanguage: parsed.data.targetLanguage,
      targetTerm: pair.target
    }))
  )
  if (!entries.success) return validation('file', 'A term is too long')
  checkNewGlossaryName('import', { ...parsed.data, visibility: 'private' }, who.userId)
  const row = await insertGlossary({
    componentId,
    userId: who.userId,
    name: parsed.data.name,
    description: parsed.data.description,
    visibility: 'private',
    entries: entries.data
  })
  const created = await findGlossary(row.id, componentId, who)
  return context.json(glossaryDetail(created!, who), 201)
})

translatorApp.get('/glossaries/:id', async (context) => {
  const { componentId } = getModuleRuntime(context, 'translator')
  const who = await viewer(context)
  const row = await findGlossary(glossaryId(context.req.param('id')), componentId, who)
  if (!row) throw new ApiError(404, 'not_found', 'Glossary not found')
  return context.json(glossaryDetail(row, who))
})

/**
 * The glossary to change: one the user may edit (`owner`: their own), else `403` (someone else's
 * they see) or `404`.
 */
async function changeableGlossary(
  context: Context<AppEnvironment>,
  owner = false
): Promise<{
  row: GlossaryRow & { creatorName: string }
  who: GlossaryViewer
  componentId: string
}> {
  const { componentId } = getModuleRuntime(context, 'translator')
  const who = await viewer(context)
  const row = await findGlossary(glossaryId(context.req.param('id')!), componentId, who)
  if (!row) throw new ApiError(404, 'not_found', 'Glossary not found')
  if (owner ? row.userId !== who.userId : !canEditGlossary(row, who)) {
    throw new ApiError(403, 'forbidden', 'Not your glossary')
  }
  return { row, who, componentId }
}

translatorApp.put('/glossaries/:id', async (context) => {
  const { visibility, description, ...input } = await parseBody(
    context,
    translatorGlossaryInputSchema
  )
  const { row, who, componentId } = await changeableGlossary(context)
  const rights = glossaryRights(row, { visibility })
  await db
    .update(translatorGlossary)
    // An empty description keeps the one there is, as in HAWKI.
    .set({ ...input, ...rights, ...(description ? { description } : {}), updatedAt: new Date() })
    .where(eq(translatorGlossary.id, row.id))
  return context.json(glossaryDetail((await findGlossary(row.id, componentId, who))!, who))
})

translatorApp.patch('/glossaries/:id', async (context) => {
  const { description, category, ...change } = await parseBody(
    context,
    translatorGlossaryPatchSchema
  )
  const { row, who, componentId } = await changeableGlossary(context)
  // Whoever edits the glossary shares it too, as in HAWKI.
  const rights = glossaryRights(row, change)
  await db
    .update(translatorGlossary)
    .set({
      ...rights,
      // Empty ones keep what there is, as in HAWKI.
      ...(description ? { description } : {}),
      ...(category ? { category } : {}),
      updatedAt: new Date()
    })
    .where(eq(translatorGlossary.id, row.id))
  return context.json(glossaryDetail((await findGlossary(row.id, componentId, who))!, who))
})

translatorApp.delete('/glossaries/:id', async (context) => {
  const { row } = await changeableGlossary(context, true)
  await db.delete(translatorGlossary).where(eq(translatorGlossary.id, row.id))
  return context.body(null, 204)
})

export const translatorAdminApp = new Hono<AppEnvironment>()

translatorAdminApp.post('/models', async (context) => {
  const input = await parseBody(context, translatorModelsRequestSchema)
  const { secrets } = getModuleRuntime(context, 'translator')
  const apiKey = input.apiKey === undefined ? secrets.llmApiKey : input.apiKey
  try {
    // An admin waits on this list, so it gives up sooner than a translation.
    const signal = AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(15_000)])
    const models = await listLlmModels(input.baseUrl, apiKey, signal)
    return context.json(translatorModelListSchema.parse({ models }))
  } catch {
    throw new ApiError(502, 'module_unavailable', 'The AI endpoint did not list its models')
  }
})

export const translatorModule: ServerModule<'translator'> = {
  type: 'translator',
  defaultName: 'Übersetzer',
  defaultNameTranslations: { en: 'Translator' },
  defaultIcon: 'languages',
  defaultConfig: {
    defaultTargetLanguage: 'en-gb',
    deeplApiUrl: null,
    llmBaseUrl: null,
    llmModels: [],
    llmProviderName: null,
    defaultEngine: null,
    documentsEnabled: false
  },
  configSchema: translatorComponentConfigSchema,
  app: translatorApp,
  adminApp: translatorAdminApp,
  start: startDocumentWorker
}
