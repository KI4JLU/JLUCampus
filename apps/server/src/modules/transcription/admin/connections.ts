import { randomUUID } from 'node:crypto'
import type { Readable } from 'node:stream'

import type {
  TRANSCRIPTION_CONNECTION_ANSWERS,
  TranscriptionConnectionFinding,
  TranscriptionConnectionTest,
  TranscriptionConnectionTestRequest,
  TranscriptionModel
} from '@justcampus/shared'
import { z } from 'zod'

import type { TranscriptionRuntime } from '../config.js'
import { openaiRealtimeEndpoints } from '../config.js'
import { bearer, listModels, upstreamFetch, UpstreamError, upstreamUrl } from '../http.js'
import { parseVerboseJson } from '../jobs/asr.js'
import { parseDiarization } from '../jobs/diarization.js'
import {
  clientSecretRequest,
  parseClientSecret,
  parseSignalingAnswer
} from '../realtime/upstream.js'
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

/** The models of an OpenAI-compatible endpoint, chat models only for `llm`. */
export async function discoverModels(
  kind: 'asr' | 'llm',
  baseUrl: string,
  apiKey: string | null,
  signal?: AbortSignal
): Promise<TranscriptionModel[]> {
  const models = await listModels(baseUrl, apiKey, signal)
  return kind === 'llm' ? chatModels(models) : models
}

/** Masks every key in a message and keeps it short. */
export function safeMessage(message: string, keys: readonly (string | null | undefined)[]): string {
  let safe = message
  for (const key of keys) if (key && key.length >= 4) safe = safe.split(key).join('***')
  return safe.replace(/Bearer\s+[\w.~+/=-]+/gi, 'Bearer ***').slice(0, 300)
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

/** A minimal SDP offer with one audio track and a data channel, for the bridge test. */
export const TEST_SDP_OFFER = [
  'v=0',
  'o=- 0 0 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0 1',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'c=IN IP4 0.0.0.0',
  'a=mid:0',
  'a=sendonly',
  'a=rtpmap:111 opus/48000/2',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=mid:1',
  'a=sctp-port:5000',
  ''
].join('\r\n')

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
  const body = await response.text().catch(() => '')
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
 * listing is only noted for speech endpoints, many of which list nothing; the operation decides.
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
    models = await discoverModels(kind, baseUrl, apiKey, signal)
  } catch (error) {
    if (kind === 'llm' || signal?.aborted) throw error
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
  const form = new FormData()
  form.set('file', new Blob([silentWav(1)], { type: 'audio/wav' }), 'test.wav')
  form.set('model', model)
  form.set('response_format', 'verbose_json')
  form.append('timestamp_granularities[]', 'segment')
  const response = await answer(
    upstreamUrl(baseUrl, 'audio/transcriptions'),
    { method: 'POST', body: form, headers: { Accept: 'application/json', ...bearer(apiKey) } },
    signal,
    OPERATION_TIMEOUT_MS
  )
  try {
    parseVerboseJson(await response.json(), 1)
  } catch {
    throw new CheckFailed({ kind: 'invalidAnswer', expected: 'transcription' }, response.status)
  }
  checks.push({ kind: 'transcribed', model })
  return response.status
}

/** A one-word chat completion with `model`. */
async function checkChat(
  checks: Finding[],
  baseUrl: string,
  apiKey: string | null,
  model: string,
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
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Antworte nur mit: OK' }],
        temperature: 0,
        max_tokens: 16,
        stream: false
      })
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
const chatAnswerSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullable().optional() }) }))
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
}

/**
 * Checks one upstream with the typed values, else the saved ones, by doing what the module does
 * with it: a second of audio recognised or diarised, a chat answer, an SDP answer from the bridge,
 * an ephemeral key from OpenAI (withheld), a stored object read back through signed URLs and
 * deleted. Model lists are reported besides, never as proof (section 5). `checks` names each
 * step; nothing in the answer is a key.
 */
export async function testConnection(
  input: TranscriptionConnectionTestRequest,
  { runtime, storage, signal }: ConnectionContext
): Promise<TranscriptionConnectionTest> {
  const { config, secrets } = runtime
  const keyOf = (saved: string | null): string | null =>
    input.apiKey === undefined ? saved : input.apiKey
  const keys = [input.apiKey, ...Object.values(secrets)]
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
        const url = input.url ?? config.asrBaseUrl
        if (!url) return notSetUp()
        const apiKey = keyOf(secrets.apiKey)
        const model = input.model ?? config.defaultAsrModel ?? config.asrModels[0]?.id ?? null
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
        return passed(await checkChat(checks, url, apiKey, model, signal))
      }
      case 'diarization': {
        const url = input.url ?? config.diarizationUrl
        if (!url) return notSetUp()
        const form = new FormData()
        form.set('file', new Blob([silentWav(1)], { type: 'audio/wav' }), 'test.wav')
        const model = input.model ?? config.diarizationModel
        if (model) form.set('model', model)
        const response = await answer(
          url,
          {
            method: 'POST',
            body: form,
            headers: { Accept: 'application/json', ...bearer(keyOf(secrets.diarizationApiKey)) }
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
        const url = input.url ?? config.onpremSignalingUrl
        if (!url) return notSetUp()
        const response = await answer(
          url,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json, application/sdp'
            },
            body: JSON.stringify({ sdp: TEST_SDP_OFFER, type: 'offer' })
          },
          signal
        )
        try {
          parseSignalingAnswer(await response.text(), response.headers.get('content-type'))
        } catch {
          throw new CheckFailed({ kind: 'invalidAnswer', expected: 'sdpAnswer' }, response.status)
        }
        checks.push({ kind: 'sdpAnswered' })
        return passed(response.status)
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
