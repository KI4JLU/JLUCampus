import type {
  TranscriptionConnectionFinding,
  TranscriptionConnectionTest,
  TranscriptionConnectionTestRequest,
  TranscriptionModel
} from '@justcampus/shared'

import type { TranscriptionRuntime } from '../config.js'
import { openaiRealtimeEndpoints } from '../config.js'
import { bearer, listModels, upstreamFetch, UpstreamError } from '../http.js'
import { clientSecretRequest } from '../realtime/upstream.js'
import type { TranscriptionStorage } from '../storage.js'

/**
 * The admin form's model discovery and connection tests. They use what the admin typed, else the
 * saved settings and keys, and never answer with a key: messages are cut short and every key
 * involved is masked in them.
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

/** Half a second of silence as a 16 kHz mono PCM WAV, for the diarisation test. */
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

interface Probe {
  status: number | null
  ok: boolean
  finding?: TranscriptionConnectionFinding
  message: string | null
}

/** Answers with the HTTP status; `ok` for 2xx. */
async function probe(url: string, init: RequestInit, signal?: AbortSignal): Promise<Probe> {
  const response = await upstreamFetch(url, { ...init, timeoutMs: TEST_TIMEOUT_MS, signal })
  const body = response.ok ? '' : await response.text().catch(() => '')
  return {
    status: response.status,
    ok: response.ok,
    message: response.ok
      ? null
      : `Status ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`
  }
}

/** Lists the endpoint's models and checks the chosen one is among them. */
async function probeModels(
  baseUrl: string,
  apiKey: string | null,
  model: string | null,
  kind: 'asr' | 'llm',
  signal?: AbortSignal
): Promise<Probe> {
  const models = await discoverModels(kind, baseUrl, apiKey, signal)
  if (model && !models.some((candidate) => candidate.id === model)) {
    return { status: 200, ok: false, finding: { kind: 'modelMissing', model }, message: null }
  }
  return { status: 200, ok: true, finding: { kind: 'models', count: models.length }, message: null }
}

export interface ConnectionContext {
  runtime: Pick<TranscriptionRuntime, 'config' | 'secrets'>
  storage: TranscriptionStorage | null
  signal?: AbortSignal
}

/** Checks one upstream with the typed values, else the saved ones. */
export async function testConnection(
  input: TranscriptionConnectionTestRequest,
  { runtime, storage, signal }: ConnectionContext
): Promise<TranscriptionConnectionTest> {
  const { config, secrets } = runtime
  const keyOf = (saved: string | null): string | null =>
    input.apiKey === undefined ? saved : input.apiKey
  const keys = [input.apiKey, ...Object.values(secrets)]
  const started = Date.now()
  const finish = (result: Probe): TranscriptionConnectionTest => ({
    ok: result.ok,
    status: result.status,
    latencyMs: Date.now() - started,
    finding: result.finding ?? null,
    message: result.message === null ? null : safeMessage(result.message, keys)
  })
  const notSetUp: TranscriptionConnectionTest = {
    ok: false,
    status: null,
    latencyMs: null,
    finding: { kind: 'notSetUp' },
    message: null
  }

  try {
    switch (input.target) {
      case 'asr': {
        const url = input.url ?? config.asrBaseUrl
        if (!url) return notSetUp
        const model = input.model ?? config.defaultAsrModel ?? config.asrModels[0]?.id ?? null
        return finish(await probeModels(url, keyOf(secrets.apiKey), model, 'asr', signal))
      }
      case 'llm': {
        const url = input.url ?? config.llmBaseUrl
        if (!url) return notSetUp
        const model = input.model ?? null
        return finish(await probeModels(url, keyOf(secrets.llmApiKey), model, 'llm', signal))
      }
      case 'diarization': {
        const url = input.url ?? config.diarizationUrl
        if (!url) return notSetUp
        const form = new FormData()
        form.set('file', new Blob([silentWav()], { type: 'audio/wav' }), 'test.wav')
        const model = input.model ?? config.diarizationModel
        if (model) form.set('model', model)
        return finish(
          await probe(
            url,
            {
              method: 'POST',
              body: form,
              headers: { Accept: 'application/json', ...bearer(keyOf(secrets.diarizationApiKey)) }
            },
            signal
          )
        )
      }
      case 'realtimeOnprem': {
        const url = input.url ?? config.onpremSignalingUrl
        if (!url) return notSetUp
        return finish(
          await probe(
            url,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
              body: JSON.stringify({ sdp: TEST_SDP_OFFER, type: 'offer' })
            },
            signal
          )
        )
      }
      case 'realtimeOpenai': {
        const apiKey = keyOf(secrets.openaiRealtimeApiKey)
        if (!apiKey) return notSetUp
        const base = input.url ?? config.openaiRealtimeUrl
        const { clientSecretsUrl } = openaiRealtimeEndpoints({ ...config, openaiRealtimeUrl: base })
        const result = await probe(
          clientSecretsUrl,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...bearer(apiKey) },
            body: JSON.stringify(clientSecretRequest(input.model ?? config.openaiRealtimeModel))
          },
          signal
        )
        // The ephemeral key issued for the test is not passed on.
        return finish(result)
      }
      case 'storage': {
        if (!storage) return notSetUp
        await storage.ping(signal)
        return finish({
          status: null,
          ok: true,
          finding: { kind: 'bucketReachable', bucket: storage.bucket },
          message: null
        })
      }
    }
  } catch (error) {
    if (signal?.aborted) throw error
    const status = error instanceof UpstreamError ? error.status : null
    const message =
      error instanceof UpstreamError
        ? error.message
        : error instanceof Error
          ? `${error.name}: ${error.message}`
          : 'The test failed'
    return finish({ status, ok: false, message })
  }
}
