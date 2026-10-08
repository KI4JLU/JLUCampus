import type { TFunction } from 'i18next'
import {
  COMPONENT_TYPES,
  componentInputSchema,
  isBuiltInType,
  LANGUAGES,
  SECRET_VALUE_MAX,
  TRANSLATOR_LLM_MODELS_MAX,
  type AdminComponent,
  type ComponentInput,
  type ComponentNameTranslations,
  type ComponentType,
  type Language
} from '@justcampus/shared'
import { componentAdapters } from '@/adapters/registry'
import { ApiRequestError } from './api'
import { secretKeysOf, secretsPatch, type SecretDrafts } from './component-secrets'

export interface ComponentFormState {
  type: ComponentType
  name: string
  /** The name per interface language; an empty field means none, so `name` shows there. */
  nameTranslations: Record<Language, string>
  icon: string | null
  iconUrl: string
  enabled: boolean
  config: ComponentInput['config']
  /** Changes to the type's secrets; untouched secrets have no draft. */
  secrets: SecretDrafts
}

/** Field errors keyed by the dotted issue path, e.g. `name`, `config.url`. */
export type FieldErrors = Partial<Record<string, string>>

/**
 * The types the type field offers. Built-in components (modules, desktop
 * components) are created by the server, one per type, and a component's type
 * cannot change into or out of a built-in type: a new or ordinary component
 * chooses among the ordinary types, a built-in one keeps its own.
 */
export function selectableTypes(component: AdminComponent | null): readonly ComponentType[] {
  if (component && isBuiltInType(component.type)) return [component.type]
  return COMPONENT_TYPES.filter((type) => !isBuiltInType(type))
}

export function initialFormState(component: AdminComponent | null): ComponentFormState {
  if (!component) {
    return {
      type: 'iframe',
      name: '',
      nameTranslations: translationFields({}),
      icon: null,
      iconUrl: '',
      enabled: true,
      config: componentAdapters.iframe.defaultConfig,
      secrets: {}
    }
  }
  return {
    type: component.type,
    name: component.name,
    nameTranslations: translationFields(component.nameTranslations),
    icon: component.icon,
    iconUrl: component.iconUrl ?? '',
    enabled: component.enabled,
    config: component.config,
    secrets: {}
  }
}

/** One field per interface language, empty where the component has no translation. */
function translationFields(translations: ComponentNameTranslations): Record<Language, string> {
  return Object.fromEntries(
    LANGUAGES.map((language) => [language, translations[language] ?? ''])
  ) as Record<Language, string>
}

/** The filled-in translations; a blank field removes its language's translation. */
function filledTranslations(fields: Record<Language, string>): ComponentNameTranslations {
  return Object.fromEntries(
    LANGUAGES.flatMap((language) =>
      fields[language].trim() ? [[language, fields[language]] as const] : []
    )
  )
}

/**
 * Whether the form holds something `baseline` does not: another value in a field, or a secret
 * that saving would set or remove. An edit undone again does not count.
 */
export function isFormDirty(state: ComponentFormState, baseline: ComponentFormState): boolean {
  if (secretsPatch(secretKeysOf(state.type), state.secrets)) return true
  return !sameValue({ ...state, secrets: null }, { ...baseline, secrets: null })
}

/**
 * Deep equality of plain values. `NaN` (an emptied number field) equals itself, and a missing
 * key equals `undefined`.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  return [...keys].every((key) => sameValue(left[key], right[key]))
}

type Issue = { path: readonly PropertyKey[]; message: string }

/**
 * Known fields get a translated message; anything else keeps the server's
 * wording. Embedded sites and the modules' APIs need https; feeds and
 * shortcuts accept http too. Paths into lists match with `*` for the index.
 */
function toFieldErrors(issues: readonly Issue[], type: ComponentType, t: TFunction): FieldErrors {
  const messages: Partial<Record<string, string>> = {
    type: t('admin.form.errors.type'),
    name: t('admin.form.errors.name'),
    // The translations are names too, with the same limits.
    ...Object.fromEntries(
      LANGUAGES.map((language) => [`nameTranslations.${language}`, t('admin.form.errors.name')])
    ),
    icon: t('admin.form.errors.icon'),
    iconUrl: t('admin.form.errors.url'),
    'config.url': t(type === 'iframe' ? 'admin.form.errors.url' : 'admin.form.errors.externalUrl'),
    'config.feedUrl': t('admin.form.errors.externalUrl'),
    'config.deeplApiUrl': t('admin.form.errors.url'),
    'config.llmBaseUrl': t('admin.form.errors.url'),
    'config.asrBaseUrl': t('admin.form.errors.url'),
    'config.diarizationUrl': t('admin.form.errors.url'),
    'config.onpremGatewayUrl': t('admin.form.errors.url'),
    'config.openaiRealtimeUrl': t('admin.form.errors.url'),
    'config.llmModels': t('component.translator.configErrors.models', {
      max: TRANSLATOR_LLM_MODELS_MAX
    }),
    'config.llmModels.*.id': t('component.translator.configErrors.modelId'),
    'config.llmModels.*.label': t('component.translator.configErrors.modelLabel')
  }
  const errors: FieldErrors = {}
  for (const issue of issues) {
    const key = issue.path.map(String).join('.') || 'form'
    const pattern = issue.path.map((part) => (typeof part === 'number' ? '*' : String(part)))
    const secret = key.startsWith('secrets.')
      ? t('admin.form.errors.secret', { max: SECRET_VALUE_MAX })
      : undefined
    errors[key] ??= messages[key] ?? messages[pattern.join('.')] ?? secret ?? issue.message
  }
  return errors
}

export type ValidationResult =
  { ok: true; input: ComponentInput } | { ok: false; errors: FieldErrors }

export function validateComponentForm(state: ComponentFormState, t: TFunction): ValidationResult {
  const iconUrl = state.iconUrl.trim()
  const secrets = secretsPatch(secretKeysOf(state.type), state.secrets)
  const result = componentInputSchema.safeParse({
    type: state.type,
    name: state.name,
    nameTranslations: filledTranslations(state.nameTranslations),
    icon: state.icon,
    iconUrl: iconUrl ? iconUrl : null,
    enabled: state.enabled,
    config: state.config,
    // Left out unless something changed, so saving keeps the stored secrets.
    ...(secrets ? { secrets } : {})
  })
  if (result.success) return { ok: true, input: result.data }
  return { ok: false, errors: toFieldErrors(result.error.issues, state.type, t) }
}

/** Server-side validation errors, mapped onto the form's fields. */
export function serverFieldErrors(
  error: unknown,
  type: ComponentType,
  t: TFunction
): FieldErrors | null {
  if (!(error instanceof ApiRequestError) || error.code !== 'validation') return null
  const issues = error.body?.error.issues ?? []
  return issues.length > 0 ? toFieldErrors(issues, type, t) : null
}

/** The errors inside `config`, keyed relative to it, for the adapter's fields. */
export function configErrors(errors: FieldErrors): FieldErrors {
  const result: FieldErrors = {}
  for (const [key, message] of Object.entries(errors)) {
    if (key.startsWith('config.')) result[key.slice('config.'.length)] = message
  }
  return result
}
