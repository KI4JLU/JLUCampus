import { randomUUID } from 'node:crypto'
import type { Readable } from 'node:stream'

import {
  firstSpeechModel,
  isSpeechModelId,
  TRANSCRIPTION_DEFAULT_DIARIZATION_MODEL,
  type TRANSCRIPTION_CONNECTION_ANSWERS,
  type TranscriptionConnectionFinding,
  type TranscriptionConnectionTest,
  type TranscriptionConnectionTestRequest,
  type TranscriptionModel
} from '@justcampus/shared'
import { z } from 'zod'

import { env } from '../../../env.js'
import type { TranscriptionRuntime } from '../config.js'
import { asrBaseUrls, openaiRealtimeEndpoints } from '../config.js'
import {
  bearer,
  listModels,
  maskSecrets,
  secretsOfResponse,
  upstreamFetch,
  UpstreamError,
  upstreamUrl
} from '../http.js'
import { parseVerboseJson, transcriptionForm } from '../jobs/asr.js'
import { diarizationForm, parseDiarization } from '../jobs/diarization.js'
import {
  bridgeEndpoints,
  OnpremUnavailable,
  onpremSignaling,
  onpremTarget,
  probeOnprem
} from '../realtime/bridge.js'
import { probeOffer } from '../realtime/sdp.js'
import { completionBody, withoutThinking } from '../summaries/chat.js'
import { clientSecretRequest, parseClientSecret } from '../realtime/upstream.js'
import type { TranscriptionStorage } from '../storage.js'

/**
 * The admin form's model discovery and connection tests. They use what the admin typed, else the
 * saved settings and keys, and never answer with a key: messages are cut short and every key
 * involved is masked in them. A test does the operation itself; a model list proves nothing about
 * audio or chat support.
 */

/** Ids of models that do not chat: embeddings, rerankers, speech, image generation, moderation. */
const nonChatModel = /embed|rerank|whisper|tts|transcri|dall-e|image|moderation/i

/** The chat models of a list, for `llmModels`; speech lists are taken whole. */
export function chatModels(models: readonly TranscriptionModel[]): TranscriptionModel[] {
  return models.filter((model) => !nonChatModel.test(model.id))
}

const modelInfoSchema = z.object({
  data: z.array(
    z.object({
      model_name: z.string(),
      model_info: z.object({ mode: z.string().nullish() }).nullish()
    })
  )
})

/**
 * LiteLLM's `GET <baseUrl>/model/info`: the mode of each model it names (`chat`, `embedding`,
 * `audio_transcription`, …), where it has one. Empty for an endpoint without it (not LiteLLM) or
 * when it fails: the ids decide then.
 */
export async function modelModes(
  baseUrl: string,
  apiKey: string | null,
  signal?: AbortSignal
): Promise<Map<string, string>> {
  const modes = new Map<string, string>()
  try {
    const response = await upstreamFetch(upstreamUrl(baseUrl, 'model/info'), {
      headers: { Accept: 'application/json', ...bearer(apiKey) },
      timeoutMs: 5000,
      signal
    })
    if (!response.ok) {
      await response.body?.cancel()
      return modes
    }
    const parsed = modelInfoSchema.safeParse(await response.json())
    if (!parsed.success) return modes
    for (const entry of parsed.data.data) {
      const mode = entry.model_info?.mode
      if (mode) modes.set(entry.model_name.trim(), mode)
    }
  } catch (error) {
    if (signal?.aborted) throw error
  }
  return modes
}

/**
 * The speech recognition models of a list in its order, marked `speech`: LiteLLM's
 * `audio_transcription` mode where the endpoint names a mode, else by id (`isSpeechModelId`).
 * The mark keeps that classification in the saved list, so `firstSpeechModel` takes the first
 * of them even where its id says nothing.
 */
export function speechModels(
  models: readonly TranscriptionModel[],
  modes: ReadonlyMap<string, string> = new Map()
): TranscriptionModel[] {
  return models
    .filter((model) => {
      const mode = modes.get(model.id)
      return mode ? mode === 'audio_transcription' : isSpeechModelId(model.id)
    })
    .map((model) => ({ ...model, speech: true }))
}

/**
 * The models of an OpenAI-compatible endpoint of the kind asked for: speech recognition models
 * for `asr`, chat models for `llm`; `leftOut` counts the others.
 */
export async function discoverModels(
  kind: 'asr' | 'llm',
  baseUrl: string,
  apiKey: string | null,
  signal?: AbortSignal
): Promise<{ models: TranscriptionModel[]; leftOut: number }> {
  const all = await listModels(baseUrl, apiKey, signal)
  const models =
    kind === 'llm' ? chatModels(all) : speechModels(all, await modelModes(baseUrl, apiKey, signal))
  return { models, leftOut: all.length - models.length }
}

/** Masks every key in a message and keeps it short. */
export function safeMessage(message: string, keys: readonly (string | null | undefined)[]): string {
  return maskSecrets(message, keys).slice(0, 300)
}

/** Silence as a 16 kHz mono PCM WAV, for the speech and diarisation tests. */
export function silentWav(seconds = 0.5, sampleRate = 16_000): Uint8Array {
  const samples = Math.round(seconds * sampleRate)
  const buffer = new ArrayBuffer(44 + samples * 2)
  const view = new DataView(buffer)
  const text = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index))
    }
  }
  text(0, 'RIFF')
  view.setUint32(4, 36 + samples * 2, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, samples * 2, true)
  return new Uint8Array(buffer)
}

const TEST_TIMEOUT_MS = 15_000
/** A speech or chat call on a slow, cold model may take longer than a listing. */
const OPERATION_TIMEOUT_MS = 60_000

type Finding = TranscriptionConnectionFinding

/** A check that failed: its finding, the upstream's status and its own words. */
class CheckFailed extends Error {
  constructor(
    readonly finding: Finding | null,
    readonly status: number | null,
    message: string | null = null
  ) {
    super(message ?? 'check failed')
  }
}

/** What a test found: the decisive finding last among `checks`. */
interface Outcome {
  ok: boolean
  status: number | null
  checks: Finding[]
  message: string | null
}

/** A response that must be 2xx; otherwise its status and the start of its body. */
async function answer(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
  timeoutMs = TEST_TIMEOUT_MS
): Promise<Response> {
  const response = await upstreamFetch(url, { ...init, timeoutMs, signal })
  if (response.ok) return response
  // The whole body masked with the request's keys before it is cut short; it reaches the admin.
  const body = maskSecrets(await response.text().catch(() => ''), secretsOfResponse(response))
  throw new CheckFailed(
    null,
    response.status,
    `Status ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`
  )
}

/** The JSON of a 2xx answer, else a failed check expecting `expected`. */
async function jsonOf(
  response: Response,
  expected: (typeof TRANSCRIPTION_CONNECTION_ANSWERS)[number]
): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    throw new CheckFailed({ kind: 'invalidAnswer', expected }, response.status)
  }
}

/**
 * Lists the endpoint's models: the count, or that the chosen model is not among them. A failed
 * listing is only noted: many endpoints list nothing, and models can be configured by hand
 * (section 5). The operation with the model decides, and fails for a wrong key as well.
 */
async function listedModels(
  checks: Finding[],
  baseUrl: string,
  apiKey: string | null,
  model: string | null,
  kind: 'asr' | 'llm',
  signal?: AbortSignal
): Promise<void> {
  let models: TranscriptionModel[]
  try {
    // The whole speech list: the model chosen may be an id the admin typed.
    const all = await listModels(baseUrl, apiKey, signal)
    models = kind === 'llm' ? chatModels(all) : all
  } catch (error) {
    if (signal?.aborted) throw error
    checks.push({ kind: 'modelsUnlisted' })
    return
  }
  checks.push({ kind: 'models', count: models.length })
  if (model && !models.some((candidate) => candidate.id === model)) {
    checks.push({ kind: 'modelMissing', model })
  }
}

/** Recognises a second of silence with `model`, the way jobs do (`verbose_json`). */
async function checkTranscription(
  checks: Finding[],
  baseUrl: string,
  apiKey: string | null,
  model: string,
  signal?: AbortSignal
): Promise<number> {
  const form = transcriptionForm(new Blob([silentWav(1)], { type: 'audio/wav' }), {
    model,
    language: 'auto'
  })
  const response = await answer(
    upstreamUrl(baseUrl, 'audio/transcriptions'),
    { method: 'POST', body: form, headers: { Accept: 'application/json', ...bearer(apiKey) } },
    signal,
    OPERATION_TIMEOUT_MS
  )
  const body = await jsonOf(response, 'transcription')
  try {
    if (!transcriptionAnswerSchema.safeParse(body).success) throw new Error('Not a transcription')
    parseVerboseJson(body, 1)
  } catch {
    throw new CheckFailed({ kind: 'invalidAnswer', expected: 'transcription' }, response.status)
  }
  checks.push({ kind: 'transcribed', model })
  return response.status
}

/**
 * What a transcription answer has to be beyond what jobs read leniently: Whisper's `verbose_json`
 * with its `text`, empty for silence, and no error envelope; segments, if any, as a list.
 */
const transcriptionAnswerSchema = z
  .looseObject({ text: z.string(), segments: z.array(z.unknown()).optional() })
  .refine((body) => !('error' in body))

/**
 * A one-word chat completion with `model`, sent as the module's requests are (thinking off when
 * `disableThinking`), so a refused `chat_template_kwargs` shows here.
 */
async function checkChat(
  checks: Finding[],
  baseUrl: string,
  apiKey: string | null,
  model: string,
  disableThinking: boolean,
  signal?: AbortSignal
): Promise<number> {
  const response = await answer(
    upstreamUrl(baseUrl, 'chat/completions'),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...bearer(apiKey)
      },
      body: JSON.stringify(
        completionBody(
          { model, disableThinking },
          [{ role: 'user', content: 'Antworte nur mit: OK' }],
          {
            temperature: 0,
            // Room for reasoning models, which think before they answer.
            maxTokens: 256
          }
        )
      )
    },
    signal,
    OPERATION_TIMEOUT_MS
  )
  const parsed = chatAnswerSchema.safeParse(await jsonOf(response, 'chat'))
  if (!parsed.success) {
    throw new CheckFailed({ kind: 'invalidAnswer', expected: 'chat' }, response.status)
  }
  checks.push({ kind: 'chatAnswered', model })
  return response.status
}
/** A completion with an answer: text in the first choice, besides any thinking. */
const chatAnswerSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().refine((content) => withoutThinking(content) !== '')
        })
      })
    )
    .min(1)
})

/** Signed upload and download of a small object, read back, deleted and gone (T-03, T-04). */
async function checkStorage(
  checks: Finding[],
  storage: TestStorage,
  componentId: string,
  signal?: AbortSignal
): Promise<void> {
  const key = `transcription/${componentId}/connection-tests/${randomUUID()}.txt`
  const content = `JLU Campus storage test ${randomUUID()}`
  const bytes = new TextEncoder().encode(content)
  const contentType = 'text/plain'
  let signed = true
  try {
    const upload = await storage.presignUpload(key, {
      contentType,
      contentLength: bytes.byteLength,
      expiresIn: 60
    })
    try {
      await answer(upload.url, { method: 'PUT', headers: upload.headers, body: bytes }, signal)
    } catch (error) {
      // Signed URLs point at the public endpoint, which this server may not reach itself.
      if (!(error instanceof UpstreamError) || error.status !== null) throw error
      signed = false
      checks.push({ kind: 'signedUrlsUnreachable' })
      await storage.put(key, bytes, { contentType, contentLength: bytes.byteLength, signal })
    }
    let stored: string
    if (signed) {
      const download = await storage.presignDownload(key, { expiresIn: 60 })
      stored = await (await answer(download.url, { method: 'GET' }, signal)).text()
    } else {
      stored = await text(await storage.get(key, signal))
    }
    if (stored !== content) {
      throw new CheckFailed({ kind: 'invalidAnswer', expected: 'storedContent' }, null)
    }
  } finally {
    await storage.delete(key).catch(() => {})
  }
  if (await storage.head(key, signal)) {
    throw new CheckFailed(null, null, `The test object ${key} could not be deleted`)
  }
  checks.push({
    kind: signed ? 'signedRoundTrip' : 'serverRoundTrip',
    bucket: storage.bucket
  })
}

async function text(stream: Readable): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks).toString('utf8')
}

/** What the storage test uses of the storage. */
export type TestStorage = Pick<
  TranscriptionStorage,
  'bucket' | 'presignUpload' | 'presignDownload' | 'put' | 'get' | 'delete' | 'head'
>

export interface ConnectionContext {
  runtime: Pick<TranscriptionRuntime, 'config' | 'secrets'> &
    Partial<Pick<TranscriptionRuntime, 'componentId'>>
  storage: TestStorage | null
  signal?: AbortSignal
  /** The realtime bridge's key; left out: `TRANSCRIPTION_REALTIME_BRIDGE_KEY`. */
  bridgeKey?: string
}

/**
 * Checks one upstream with the typed values, else the saved ones, by doing what the module does
 * with it: a second of audio recognised or diarised, a chat answer, the bridge running, the
 * gateway taking key and realtime model (else why not: `realtimeUnavailable`) and a usable SDP
 * answer to a browser-like offer, an unexpired ephemeral key from OpenAI (withheld), a stored
 * object read back through signed URLs and deleted. A 2xx answer of another shape fails. Model lists are reported besides, never as proof (section 5). `checks` names each
 * step; nothing in the answer is a key.
 */
export async function testConnection(
  input: TranscriptionConnectionTestRequest,
  { runtime, storage, signal, bridgeKey = env.TRANSCRIPTION_REALTIME_BRIDGE_KEY }: ConnectionContext
): Promise<TranscriptionConnectionTest> {
  const { config, secrets } = runtime
  const keyOf = (saved: string | null): string | null =>
    input.apiKey === undefined ? saved : input.apiKey
  const keys = [input.apiKey, bridgeKey, ...Object.values(secrets)]
  const started = Date.now()
  const checks: Finding[] = []
  const finish = (outcome: Outcome): TranscriptionConnectionTest => ({
    ok: outcome.ok,
    status: outcome.status,
    latencyMs: Date.now() - started,
    finding: outcome.checks.at(-1) ?? null,
    checks: outcome.checks,
    message: outcome.message === null ? null : safeMessage(outcome.message, keys)
  })
  const passed = (status: number | null): TranscriptionConnectionTest =>
    finish({ ok: true, status, checks, message: null })
  const notSetUp = (): TranscriptionConnectionTest =>
    finish({ ok: false, status: null, checks: [{ kind: 'notSetUp' }], message: null })
  const noModel = (): TranscriptionConnectionTest =>
    finish({ ok: false, status: null, checks: [...checks, { kind: 'noModel' }], message: null })

  try {
    switch (input.target) {
      case 'asr': {
        // Several workers: the first is checked, as the admin form sends it.
        const url = input.url ?? asrBaseUrls(config)[0]
        if (!url) return notSetUp()
        const apiKey = keyOf(secrets.apiKey)
        const model =
          input.model ?? config.defaultAsrModel ?? firstSpeechModel(config.asrModels)?.id ?? null
        await listedModels(checks, url, apiKey, model, 'asr', signal)
        if (!model) return noModel()
        return passed(await checkTranscription(checks, url, apiKey, model, signal))
      }
      case 'llm': {
        const url = input.url ?? config.llmBaseUrl
        if (!url) return notSetUp()
        const apiKey = keyOf(secrets.llmApiKey)
        const model = input.model ?? config.defaultSummaryModel ?? config.llmModels[0]?.id ?? null
        await listedModels(checks, url, apiKey, model, 'llm', signal)
        if (!model) return noModel()
        const disableThinking = input.disableThinking ?? config.llmDisableThinking
        return passed(await checkChat(checks, url, apiKey, model, disableThinking, signal))
      }
      case 'diarization': {
        // kiChat's resolution: no own server is the speech server, no own key the speech key.
        const url = input.url ?? config.diarizationUrl ?? asrBaseUrls(config)[0]
        if (!url) return notSetUp()
        const apiKey = keyOf(secrets.diarizationApiKey ?? secrets.apiKey) ?? secrets.apiKey
        const form = diarizationForm(new Blob([silentWav(1)], { type: 'audio/wav' }), {
          model: input.model ?? config.diarizationModel ?? TRANSCRIPTION_DEFAULT_DIARIZATION_MODEL,
          speakerCount: 'auto'
        })
        const response = await answer(
          upstreamUrl(url, 'audio/diarization'),
          {
            method: 'POST',
            body: form,
            headers: { Accept: 'application/json', ...bearer(apiKey) }
          },
          signal,
          OPERATION_TIMEOUT_MS
        )
        let turns: number
        try {
          turns = parseDiarization(await response.json()).length
        } catch {
          throw new CheckFailed({ kind: 'invalidAnswer', expected: 'diarization' }, response.status)
        }
        checks.push({ kind: 'diarized', turns })
        return passed(response.status)
      }
      case 'realtimeOnprem': {
        const target = onpremTarget(config, secrets, bridgeKey, {
          bridgeUrl: input.bridgeUrl ?? input.url,
          gatewayUrl: input.gatewayUrl,
          apiKey: input.apiKey,
          model: input.model
        })
        if (!target) return notSetUp()
        const unavailable = (error: unknown): never => {
          if (error instanceof OnpremUnavailable) {
            throw new CheckFailed(
              { kind: 'realtimeUnavailable', reason: error.reason, model: target.model },
              error.status
            )
          }
          throw error
        }
        // The bridge runs, then the gateway takes key and model, then the bridge answers an offer.
        try {
          await answer(bridgeEndpoints(target.bridgeUrl).health, { method: 'GET' }, signal)
        } catch (error) {
          if (error instanceof UpstreamError && error.status === null && !signal?.aborted) {
            unavailable(new OnpremUnavailable('bridgeUnreachable', target.model, null))
          }
          throw error
        }
        checks.push({ kind: 'bridgeReachable' })
        await probeOnprem(target, signal, TEST_TIMEOUT_MS).catch(unavailable)
        checks.push({ kind: 'realtimeModelAccepted', model: target.model })
        try {
          await onpremSignaling(target, probeOffer(), signal)
        } catch (error) {
          if (error instanceof UpstreamError && error.status === 200) {
            throw new CheckFailed({ kind: 'invalidAnswer', expected: 'sdpAnswer' }, 200)
          }
          unavailable(error)
        }
        checks.push({ kind: 'sdpAnswered' })
        return passed(200)
      }
      case 'realtimeOpenai': {
        const apiKey = keyOf(secrets.openaiRealtimeApiKey)
        if (!apiKey) return notSetUp()
        const base = input.url ?? config.openaiRealtimeUrl
        const model = input.model ?? config.openaiRealtimeModel
        const { clientSecretsUrl } = openaiRealtimeEndpoints({ ...config, openaiRealtimeUrl: base })
        const response = await answer(
          clientSecretsUrl,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...bearer(apiKey) },
            body: JSON.stringify(clientSecretRequest(model))
          },
          signal
        )
        try {
          // The ephemeral key issued for the test is checked, not passed on.
          parseClientSecret(await response.json())
        } catch {
          throw new CheckFailed(
            { kind: 'invalidAnswer', expected: 'clientSecret' },
            response.status
          )
        }
        checks.push({ kind: 'keyIssued', model })
        return passed(response.status)
      }
      case 'storage': {
        if (!storage) return notSetUp()
        await checkStorage(checks, storage, runtime.componentId ?? 'admin', signal)
        return passed(null)
      }
    }
  } catch (error) {
    if (signal?.aborted) throw error
    if (error instanceof CheckFailed) {
      return finish({
        ok: false,
        status: error.status,
        checks: error.finding ? [...checks, error.finding] : checks,
        message: error.finding ? null : error.message
      })
    }
    const status = error instanceof UpstreamError ? error.status : null
    const message =
      error instanceof UpstreamError
        ? error.message
        : error instanceof Error
          ? `${error.name}: ${error.message}`
          : 'The test failed'
    return finish({ ok: false, status, checks, message })
  }
}
