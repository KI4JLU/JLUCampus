import {
  firstSpeechModel,
  TRANSCRIPTION_DEFAULT_CONFIG,
  TRANSCRIPTION_DEFAULT_DIARIZATION_MODEL,
  transcriptionCapabilitiesSchema,
  transcriptionComponentConfigSchema,
  type TranscriptionCapabilities,
  type TranscriptionComponentConfig,
  type TranscriptionModel,
  type TranscriptionRealtimeMode,
  transcriptionUrls
} from '@justcampus/shared'

import { loadModuleRuntime } from '../runtime.js'
import type { ModuleRuntime, ModuleSecretsMap } from '../types.js'

export type TranscriptionRuntime = ModuleRuntime<'transcription'>
export type TranscriptionSecrets = ModuleSecretsMap['transcription']

export { transcriptionComponentConfigSchema as transcriptionConfigSchema }

/** A fresh module's settings, which the server inserts disabled. */
export const transcriptionDefaultConfig: TranscriptionComponentConfig = TRANSCRIPTION_DEFAULT_CONFIG

/**
 * The module's row with config and decrypted secrets for work outside a request (the job worker,
 * the retention sweep); `null` while it is missing or disabled.
 */
export function loadTranscriptionRuntime(): Promise<TranscriptionRuntime | null> {
  return loadModuleRuntime('transcription', transcriptionComponentConfigSchema, true)
}

/**
 * The speech model jobs use: the admin's default if listed, else the first speech model of the
 * list (`firstSpeechModel`: the first discovery classified, or whose id names one, else the
 * first); `null` without one.
 */
export function asrModel(config: TranscriptionComponentConfig): TranscriptionModel | null {
  return (
    config.asrModels.find((model) => model.id === config.defaultAsrModel) ??
    firstSpeechModel(config.asrModels)
  )
}

/** The speech workers of `asrBaseUrl` (comma-separated, kiChat's `base_url`), in order. */
export function asrBaseUrls(config: Pick<TranscriptionComponentConfig, 'asrBaseUrl'>): string[] {
  return transcriptionUrls(config.asrBaseUrl)
}

/** Where diarisation goes, as kiChat resolves it; `null` while it is off or has no server. */
export interface DiarizationSetup {
  /** `diarizationUrl`, else the first speech worker (kiChat: empty = the batch server). */
  baseUrl: string
  /** `diarizationApiKey`, else the speech key. */
  apiKey: string | null
  model: string
}

export function diarizationSetup(
  config: TranscriptionComponentConfig,
  secrets: TranscriptionSecrets
): DiarizationSetup | null {
  if (!config.diarizationEnabled) return null
  const baseUrl = config.diarizationUrl ?? asrBaseUrls(config)[0] ?? null
  if (!baseUrl) return null
  return {
    baseUrl,
    apiKey: secrets.diarizationApiKey ?? secrets.apiKey,
    model: config.diarizationModel ?? TRANSCRIPTION_DEFAULT_DIARIZATION_MODEL
  }
}

/**
 * The chat model for a purpose: the one asked for if the admin listed it, else the purpose's
 * default if listed, else the first; `null` without a chat endpoint or models. A model that is not
 * listed is never used, so users cannot pick arbitrary (costly) models.
 */
export function llmModel(
  config: TranscriptionComponentConfig,
  purpose: 'correction' | 'summary',
  requested: string | null = null
): string | null {
  if (!config.llmBaseUrl) return null
  const listed = (id: string | null): string | null =>
    id && config.llmModels.some((model) => model.id === id) ? id : null
  const fallback =
    purpose === 'correction' ? config.defaultCorrectionModel : config.defaultSummaryModel
  return listed(requested) ?? listed(fallback) ?? config.llmModels[0]?.id ?? null
}

/**
 * The gateway of the on-prem live path up to `/v1`: the admin's, else the speech endpoint (its
 * first worker); `null` without either.
 */
export function onpremGatewayUrl(
  config: Pick<TranscriptionComponentConfig, 'onpremGatewayUrl' | 'asrBaseUrl'>
): string | null {
  return config.onpremGatewayUrl ?? (config.asrBaseUrl?.split(',')[0]?.trim() || null)
}

/** The live modes that are set up: on-prem needs a gateway, OpenAI its key. */
export function realtimeModes(
  config: TranscriptionComponentConfig,
  secrets: TranscriptionSecrets
): TranscriptionRealtimeMode[] {
  return config.realtimeModes.filter((mode) =>
    mode === 'onprem' ? onpremGatewayUrl(config) !== null : secrets.openaiRealtimeApiKey !== null
  )
}

export function defaultRealtimeMode(
  config: TranscriptionComponentConfig,
  modes: readonly TranscriptionRealtimeMode[]
): TranscriptionRealtimeMode | null {
  return config.defaultRealtimeMode && modes.includes(config.defaultRealtimeMode)
    ? config.defaultRealtimeMode
    : (modes[0] ?? null)
}

/**
 * What the module offers, from its settings, secrets and whether object storage is configured.
 * A capability is only reported when everything it needs is set up.
 */
export function capabilitiesOf(
  config: TranscriptionComponentConfig,
  secrets: TranscriptionSecrets,
  storageConfigured: boolean
): TranscriptionCapabilities {
  const speechModel = asrModel(config)
  const chat = config.llmBaseUrl !== null && config.llmModels.length > 0
  const modes = realtimeModes(config, secrets)
  return transcriptionCapabilitiesSchema.parse({
    batch: storageConfigured && asrBaseUrls(config).length > 0 && speechModel !== null,
    // Off, every file gets one automatic voice; a diariser that turns out unavailable says so on
    // the job (`diarization_failed` as a notice).
    diarization: diarizationSetup(config, secrets) !== null,
    llmCorrection: chat,
    summaries: chat,
    speakerOptimization: chat,
    realtimeModes: modes,
    defaultRealtimeMode: defaultRealtimeMode(config, modes),
    asrModel: speechModel,
    provider: config.providerName,
    summaryModels: chat ? config.llmModels : [],
    defaultSummaryModel: llmModel(config, 'summary'),
    defaults: {
      language: config.defaultLanguage,
      speakerCount: config.defaultSpeakerCount,
      llmCorrection: chat && config.defaultLlmCorrection
    },
    limits: {
      maxFileBytes: config.maxFileBytes,
      maxDurationSeconds: config.maxDurationSeconds,
      // `null` without the admin's limit: no limit, as in kiChat (T-04, T-13). The browser still
      // stops at the contract's anti-abuse bound, `TRANSCRIPTION_GROUP_FILES_MAX`.
      maxFilesPerGroup: config.maxFilesPerGroup,
      maxActiveJobs: config.maxActiveJobsPerUser
    },
    retention: {
      transcriptHours: config.transcriptRetentionHours,
      unsavedJobHours: config.unsavedJobRetentionHours
    }
  })
}
