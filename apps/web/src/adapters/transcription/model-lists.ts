import {
  TRANSCRIPTION_MODELS_MAX,
  type TranscriptionComponentConfig,
  type TranscriptionModel
} from '@justcampus/shared'

// The model lists of the admin form: edited by hand or fetched, and the defaults that name them.

type Config = TranscriptionComponentConfig
export type ModelField = 'asrModels' | 'llmModels'
export type DefaultModelField = 'defaultAsrModel' | 'defaultCorrectionModel' | 'defaultSummaryModel'

/** The defaults that name a model of each list. */
const DEFAULTS_OF: Record<ModelField, readonly DefaultModelField[]> = {
  asrModels: ['defaultAsrModel'],
  llmModels: ['defaultCorrectionModel', 'defaultSummaryModel']
}

/**
 * The config with `models` as the list. A default follows its model through a changed id
 * (`renamed`) and falls back to the first model when its model is gone. A default that was not
 * listed before (a fresh module's HRZ models before `Modelle abrufen`) stays while the list is
 * edited by hand; a fetched list keeps it only if the endpoint has it (`fetched`).
 */
export function withModels(
  config: Config,
  field: ModelField,
  models: TranscriptionModel[],
  renamed?: { from: string; to: string },
  fetched = false
): Config {
  const next: Config = { ...config, [field]: models }
  const listed = (list: readonly TranscriptionModel[], id: string): boolean =>
    list.some((model) => model.id.trim() === id)
  for (const key of DEFAULTS_OF[field]) {
    const current = config[key]
    if (current === null) continue
    if (renamed && current === renamed.from) next[key] = renamed.to.trim() || null
    else if ((fetched || listed(config[field], current)) && !listed(models, current)) {
      next[key] = null
    }
  }
  return next
}

/** The endpoint's models in place of the listed ones; display names the admin gave stay. */
export function withFetchedModels(
  config: Config,
  field: ModelField,
  fetched: readonly TranscriptionModel[]
): { config: Config; omitted: number } {
  const labels = new Map(
    config[field]
      .filter((model) => model.label.trim())
      .map((model) => [model.id.trim(), model.label])
  )
  const models = fetched.slice(0, TRANSCRIPTION_MODELS_MAX).map((model) => ({
    id: model.id,
    label: labels.get(model.id) ?? model.label,
    // Discovery's classification, which picks the first speech model (`firstSpeechModel`).
    ...(model.speech ? { speech: true as const } : {})
  }))
  return {
    config: withModels(config, field, models, undefined, true),
    omitted: Math.max(0, fetched.length - TRANSCRIPTION_MODELS_MAX)
  }
}
