import {
  TRANSCRIPTION_DEFAULT_CONFIG,
  TRANSCRIPTION_GROUP_FILES_MAX,
  transcriptionCapabilitiesSchema,
  transcriptionComponentConfigSchema,
  type TranscriptionCapabilities,
  type TranscriptionComponentConfig,
  type TranscriptionModel,
  type TranscriptionRealtimeMode
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

/** The speech model jobs use: the admin's default if listed, else the first; `null` without one. */
export function asrModel(config: TranscriptionComponentConfig): TranscriptionModel | null {
  return (
    config.asrModels.find((model) => model.id === config.defaultAsrModel) ??
    config.asrModels[0] ??
    null
  )
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

/** The live modes that are set up: on-prem needs its bridge, OpenAI its key. */
export function realtimeModes(
  config: TranscriptionComponentConfig,
  secrets: TranscriptionSecrets
): TranscriptionRealtimeMode[] {
  return config.realtimeModes.filter((mode) =>
    mode === 'onprem' ? config.onpremSignalingUrl !== null : secrets.openaiRealtimeApiKey !== null
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

/** Where the server asks OpenAI for ephemeral keys, and where browsers send their SDP offer. */
export function openaiRealtimeEndpoints(config: TranscriptionComponentConfig): {
  clientSecretsUrl: string
  callsUrl: string
} {
  const base = config.openaiRealtimeUrl.replace(/\/+$/, '')
  return { clientSecretsUrl: `${base}/realtime/client_secrets`, callsUrl: `${base}/realtime/calls` }
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
    batch: storageConfigured && config.asrBaseUrl !== null && speechModel !== null,
    diarization: config.diarizationEnabled && config.diarizationUrl !== null,
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
      // Without the admin's limit the contract's own one applies, which the save takes at most
      // (T-04, T-13): the browser stops at it with its alert instead of failing the save.
      maxFilesPerGroup: config.maxFilesPerGroup ?? TRANSCRIPTION_GROUP_FILES_MAX,
      maxActiveJobs: config.maxActiveJobsPerUser
    },
    retention: {
      transcriptHours: config.transcriptRetentionHours,
      unsavedJobHours: config.unsavedJobRetentionHours
    }
  })
}
