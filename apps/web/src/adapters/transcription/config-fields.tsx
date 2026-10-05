import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { DownloadIcon, PlugZapIcon, PlusIcon, Trash2Icon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Checkbox,
  FormDescription,
  FormItem,
  FormMessage,
  Input,
  Label,
  PanelSection,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '@ki4jlu/design-system'
import {
  TRANSCRIPTION_DEFAULT_DIARIZATION_MODEL,
  TRANSCRIPTION_DEFAULT_REALTIME_MODEL,
  TRANSCRIPTION_GROUP_FILES_MAX,
  TRANSCRIPTION_LANGUAGES,
  TRANSCRIPTION_MODELS_MAX,
  TRANSCRIPTION_REALTIME_MODES,
  TRANSCRIPTION_SPEAKER_COUNTS,
  TRANSCRIPTION_TURN_AUTH,
  type TranscriptionComponentConfig,
  type TranscriptionConnectionFinding,
  type TranscriptionConnectionTarget,
  type TranscriptionConnectionTest,
  type TranscriptionConnectionTestRequest,
  type TranscriptionIceServer,
  type TranscriptionLanguage,
  type TranscriptionModel,
  type TranscriptionModelKind,
  type TranscriptionRealtimeMode,
  type TranscriptionSpeakerCount,
  type TranscriptionTurnAuth,
  firstSpeechModel,
  transcriptionUrls
} from '@justcampus/shared'
import { Field } from '@/components/field'
import { ApiRequestError } from '@/lib/api'
import type { SecretDraft } from '@/lib/component-secrets'
import { cn } from '@/lib/utils'
import type { ComponentConfigFieldsProps } from '../types'
import { useFetchAdminModels, useTestAdminConnection } from './api'
import {
  withFetchedModels,
  withModels,
  type DefaultModelField,
  type ModelField
} from './model-lists'

/** Radix Select needs a non-empty value; this one stands for "no default", i.e. the first. */
const AUTO = 'auto'
const MEBIBYTE = 1024 * 1024

const ICON = { 'aria-hidden': true, width: '1em', height: '1em' } as const

type Config = TranscriptionComponentConfig

/** An empty URL field means "not set". */
function urlOrNull(value: string): string | null {
  return value.trim() ? value : null
}

/** The key as the form will save it: typed, removed (`null`), or else the saved one (left out). */
function draftKey(draft: SecretDraft | undefined): string | null | undefined {
  if (draft?.remove) return null
  return draft?.value.trim() || undefined
}

/** The first error at or below `path`, e.g. of one ICE server. */
function errorAt(errors: Partial<Record<string, string>>, path: string): string | undefined {
  if (errors[path]) return errors[path]
  const key = Object.keys(errors).find((candidate) => candidate.startsWith(`${path}.`))
  return key ? errors[key] : undefined
}

/**
 * The transcription module's part of the admin form: speech recognition, speaker recognition and
 * the AI endpoint with their models (fetched from the endpoints) and connection tests, the defaults
 * of new uploads, limits, retention, and live transcription. The four API keys follow as secret
 * fields of the form (`COMPONENT_SECRETS.transcription`); model discovery and tests use the key as
 * typed, else the saved one.
 */
export function TranscriptionConfigFields({
  config,
  onChange,
  errors,
  secrets,
  idPrefix
}: ComponentConfigFieldsProps<'transcription'>): React.JSX.Element {
  const { t } = useTranslation()
  const id = (name: string): string => `${idPrefix}-${name}`
  const update = (change: Partial<Config>): void => onChange({ ...config, ...change })
  // Fetched models land in the config as it is by then, not as it was when the fetch began.
  const latest = useRef(config)
  useEffect(() => {
    latest.current = config
  })

  const firstModel = (models: readonly TranscriptionModel[]): string | undefined =>
    models.find((model) => model.id.trim())?.id.trim()
  // As the server picks it: the first model discovery classified as speech, in its order.
  const firstAsrModel = (models: readonly TranscriptionModel[]): string | undefined =>
    firstSpeechModel(models)?.id.trim()

  return (
    <>
      <PanelSection title={t('transcription.recording.admin.sections.asr')}>
        <div className="flex flex-col gap-stack-md">
          <UrlField
            id={id('asr-base-url')}
            name="asrBaseUrl"
            value={config.asrBaseUrl}
            error={errors.asrBaseUrl}
            onChange={(asrBaseUrl) => update({ asrBaseUrl })}
          />
          <Field
            id={id('provider-name')}
            label={t('transcription.recording.admin.providerName.label')}
            hint={t('transcription.recording.admin.providerName.hint')}
            error={errors.providerName}
          >
            {(control) => (
              <Input
                {...control}
                maxLength={80}
                placeholder="KI@JLU"
                value={config.providerName ?? ''}
                onChange={(event) =>
                  update({ providerName: event.target.value.trim() ? event.target.value : null })
                }
              />
            )}
          </Field>
          <ModelList
            id={id('asr-models')}
            kind="asr"
            field="asrModels"
            config={config}
            latest={latest}
            onChange={onChange}
            errors={errors}
            apiKey={draftKey(secrets.apiKey)}
          />
          <DefaultModelSelect
            id={id('default-asr-model')}
            name="defaultAsrModel"
            models={config.asrModels}
            value={config.defaultAsrModel}
            error={errors.defaultAsrModel}
            onChange={(defaultAsrModel) => update({ defaultAsrModel })}
          />
          <NumberField
            id={id('asr-concurrency')}
            name="asrConcurrency"
            value={config.asrConcurrency}
            min={1}
            max={32}
            error={errors.asrConcurrency}
            onChange={(value) => update({ asrConcurrency: value ?? Number.NaN })}
          />
          <ConnectionTest
            target="asr"
            disabled={!config.asrBaseUrl}
            request={() => ({
              target: 'asr',
              // Several workers: the first is checked.
              url: transcriptionUrls(config.asrBaseUrl)[0],
              apiKey: draftKey(secrets.apiKey),
              model: config.defaultAsrModel ?? firstAsrModel(config.asrModels)
            })}
          />
        </div>
      </PanelSection>

      <PanelSection title={t('transcription.recording.admin.sections.diarization')}>
        <div className="flex flex-col gap-stack-md">
          <SwitchField
            id={id('diarization-enabled')}
            name="diarizationEnabled"
            checked={config.diarizationEnabled}
            onChange={(diarizationEnabled) => update({ diarizationEnabled })}
          />
          <UrlField
            id={id('diarization-url')}
            name="diarizationUrl"
            value={config.diarizationUrl}
            // Empty: the speech recognition address, its first worker (kiChat's fallback).
            placeholder={transcriptionUrls(config.asrBaseUrl)[0] || 'https://'}
            error={errors.diarizationUrl}
            onChange={(diarizationUrl) => update({ diarizationUrl })}
          />
          <Field
            id={id('diarization-model')}
            label={t('transcription.recording.admin.diarizationModel.label')}
            hint={t('transcription.recording.admin.diarizationModel.hint')}
            error={errors.diarizationModel}
          >
            {(control) => (
              <Input
                {...control}
                maxLength={200}
                spellCheck={false}
                autoComplete="off"
                placeholder={TRANSCRIPTION_DEFAULT_DIARIZATION_MODEL}
                value={config.diarizationModel ?? ''}
                onChange={(event) =>
                  update({
                    diarizationModel: event.target.value.trim() ? event.target.value : null
                  })
                }
              />
            )}
          </Field>
          <ConnectionTest
            target="diarization"
            disabled={!config.diarizationUrl && !config.asrBaseUrl}
            request={() => ({
              target: 'diarization',
              // Left out, the server asks the speech recognition address, as jobs do.
              url: config.diarizationUrl ?? undefined,
              // Without a key of its own, the server uses the speech recognition key.
              apiKey: draftKey(secrets.diarizationApiKey),
              model: config.diarizationModel?.trim() || undefined
            })}
          />
        </div>
      </PanelSection>

      <PanelSection title={t('transcription.recording.admin.sections.llm')}>
        <div className="flex flex-col gap-stack-md">
          <UrlField
            id={id('llm-base-url')}
            name="llmBaseUrl"
            value={config.llmBaseUrl}
            error={errors.llmBaseUrl}
            onChange={(llmBaseUrl) => update({ llmBaseUrl })}
          />
          <ModelList
            id={id('llm-models')}
            kind="llm"
            field="llmModels"
            config={config}
            latest={latest}
            onChange={onChange}
            errors={errors}
            apiKey={draftKey(secrets.llmApiKey)}
          />
          <DefaultModelSelect
            id={id('default-correction-model')}
            name="defaultCorrectionModel"
            models={config.llmModels}
            value={config.defaultCorrectionModel}
            error={errors.defaultCorrectionModel}
            onChange={(defaultCorrectionModel) => update({ defaultCorrectionModel })}
          />
          <DefaultModelSelect
            id={id('default-summary-model')}
            name="defaultSummaryModel"
            models={config.llmModels}
            value={config.defaultSummaryModel}
            error={errors.defaultSummaryModel}
            onChange={(defaultSummaryModel) => update({ defaultSummaryModel })}
          />
          <SwitchField
            id={id('llm-disable-thinking')}
            name="llmDisableThinking"
            checked={config.llmDisableThinking}
            onChange={(llmDisableThinking) => update({ llmDisableThinking })}
          />
          <ConnectionTest
            target="llm"
            disabled={!config.llmBaseUrl}
            request={() => ({
              target: 'llm',
              url: config.llmBaseUrl ?? undefined,
              apiKey: draftKey(secrets.llmApiKey),
              model: config.defaultCorrectionModel ?? firstModel(config.llmModels),
              disableThinking: config.llmDisableThinking
            })}
          />
        </div>
      </PanelSection>

      <PanelSection title={t('transcription.recording.admin.sections.defaults')}>
        <div className="flex flex-col gap-stack-md">
          <Field
            id={id('default-language')}
            label={t('transcription.recording.admin.defaultLanguage.label')}
            hint={t('transcription.recording.admin.defaultLanguage.hint')}
            error={errors.defaultLanguage}
          >
            {(control) => (
              <Select
                value={config.defaultLanguage}
                onValueChange={(value) =>
                  update({ defaultLanguage: value as TranscriptionLanguage })
                }
              >
                <SelectTrigger {...control}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TRANSCRIPTION_LANGUAGES.map((language) => (
                    <SelectItem key={language} value={language}>
                      {t(`transcription.recording.admin.languages.${language}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
          <Field
            id={id('default-speaker-count')}
            label={t('transcription.recording.admin.defaultSpeakerCount.label')}
            hint={t('transcription.recording.admin.defaultSpeakerCount.hint')}
            error={errors.defaultSpeakerCount}
          >
            {(control) => (
              <Select
                value={config.defaultSpeakerCount}
                onValueChange={(value) =>
                  update({ defaultSpeakerCount: value as TranscriptionSpeakerCount })
                }
              >
                <SelectTrigger {...control}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TRANSCRIPTION_SPEAKER_COUNTS.map((count) => (
                    <SelectItem key={count} value={count}>
                      {t(`transcription.recording.admin.speakerCounts.${count}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
          <SwitchField
            id={id('default-llm-correction')}
            name="defaultLlmCorrection"
            checked={config.defaultLlmCorrection}
            onChange={(defaultLlmCorrection) => update({ defaultLlmCorrection })}
          />
        </div>
      </PanelSection>

      <PanelSection title={t('transcription.recording.admin.sections.limits')}>
        <div className="flex flex-col gap-stack-md">
          <NumberField
            id={id('max-file-megabytes')}
            name="maxFileMegabytes"
            value={Math.round((config.maxFileBytes / MEBIBYTE) * 100) / 100}
            min={1}
            max={10_240}
            error={errors.maxFileBytes}
            onChange={(megabytes) =>
              update({
                maxFileBytes: megabytes === null ? Number.NaN : Math.round(megabytes * MEBIBYTE)
              })
            }
          />
          <NumberField
            id={id('max-duration-minutes')}
            name="maxDurationMinutes"
            value={config.maxDurationSeconds === null ? null : config.maxDurationSeconds / 60}
            min={1}
            nullable
            error={errors.maxDurationSeconds}
            onChange={(minutes) =>
              update({ maxDurationSeconds: minutes === null ? null : Math.round(minutes * 60) })
            }
          />
          <NumberField
            id={id('max-files-per-group')}
            name="maxFilesPerGroup"
            value={config.maxFilesPerGroup}
            min={1}
            max={TRANSCRIPTION_GROUP_FILES_MAX}
            nullable
            error={errors.maxFilesPerGroup}
            onChange={(maxFilesPerGroup) => update({ maxFilesPerGroup })}
          />
          <NumberField
            id={id('max-active-jobs')}
            name="maxActiveJobsPerUser"
            value={config.maxActiveJobsPerUser}
            min={1}
            max={1000}
            error={errors.maxActiveJobsPerUser}
            onChange={(value) => update({ maxActiveJobsPerUser: value ?? Number.NaN })}
          />
          <NumberField
            id={id('worker-concurrency')}
            name="workerConcurrency"
            value={config.workerConcurrency}
            min={1}
            max={16}
            error={errors.workerConcurrency}
            onChange={(value) => update({ workerConcurrency: value ?? Number.NaN })}
          />
          <NumberField
            id={id('chunk-seconds')}
            name="chunkSeconds"
            value={config.chunkSeconds}
            min={30}
            max={3600}
            error={errors.chunkSeconds}
            onChange={(value) => update({ chunkSeconds: value ?? Number.NaN })}
          />
          <NumberField
            id={id('upstream-timeout')}
            name="upstreamTimeoutSeconds"
            value={config.upstreamTimeoutSeconds}
            min={10}
            max={3600}
            error={errors.upstreamTimeoutSeconds}
            onChange={(value) => update({ upstreamTimeoutSeconds: value ?? Number.NaN })}
          />
        </div>
      </PanelSection>

      <PanelSection title={t('transcription.recording.admin.sections.retention')}>
        <div className="flex flex-col gap-stack-md">
          <NumberField
            id={id('transcript-retention')}
            name="transcriptRetentionHours"
            value={config.transcriptRetentionHours}
            min={1}
            max={87_600}
            nullable
            error={errors.transcriptRetentionHours}
            onChange={(transcriptRetentionHours) => update({ transcriptRetentionHours })}
          />
          <NumberField
            id={id('unsaved-job-retention')}
            name="unsavedJobRetentionHours"
            value={config.unsavedJobRetentionHours}
            min={1}
            max={720}
            error={errors.unsavedJobRetentionHours}
            onChange={(value) => update({ unsavedJobRetentionHours: value ?? Number.NaN })}
          />
        </div>
      </PanelSection>

      <PanelSection title={t('transcription.recording.admin.sections.live')}>
        <div className="flex flex-col gap-stack-md">
          <RealtimeModesField
            id={id('realtime-modes')}
            modes={config.realtimeModes}
            error={errors.realtimeModes}
            onChange={(realtimeModes) =>
              update({
                realtimeModes,
                defaultRealtimeMode:
                  config.defaultRealtimeMode && realtimeModes.includes(config.defaultRealtimeMode)
                    ? config.defaultRealtimeMode
                    : null
              })
            }
          />
          <Field
            id={id('default-realtime-mode')}
            label={t('transcription.recording.admin.defaultRealtimeMode.label')}
            hint={t('transcription.recording.admin.defaultRealtimeMode.hint')}
            error={errors.defaultRealtimeMode}
          >
            {(control) => (
              <Select
                value={config.defaultRealtimeMode ?? AUTO}
                onValueChange={(value) =>
                  update({
                    defaultRealtimeMode:
                      value === AUTO ? null : (value as TranscriptionRealtimeMode)
                  })
                }
              >
                <SelectTrigger {...control}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={AUTO}>
                    {t('transcription.recording.admin.defaultRealtimeMode.auto')}
                  </SelectItem>
                  {config.realtimeModes.map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {t(`transcription.recording.admin.modes.${mode}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
          <UrlField
            id={id('onprem-signaling-url')}
            name="onpremSignalingUrl"
            value={config.onpremSignalingUrl}
            placeholder="http://localhost:8089"
            error={errors.onpremSignalingUrl}
            onChange={(onpremSignalingUrl) => update({ onpremSignalingUrl })}
          />
          <UrlField
            id={id('onprem-gateway-url')}
            name="onpremGatewayUrl"
            value={config.onpremGatewayUrl}
            // Empty: the speech recognition address, its first worker.
            placeholder={config.asrBaseUrl?.split(',')[0]?.trim() || 'https://'}
            error={errors.onpremGatewayUrl}
            onChange={(onpremGatewayUrl) => update({ onpremGatewayUrl })}
          />
          <Field
            id={id('onprem-realtime-model')}
            label={t('transcription.recording.admin.onpremRealtimeModel.label')}
            hint={t('transcription.recording.admin.onpremRealtimeModel.hint')}
            error={errors.onpremRealtimeModel}
          >
            {(control) => (
              <Input
                {...control}
                maxLength={200}
                spellCheck={false}
                autoComplete="off"
                placeholder={TRANSCRIPTION_DEFAULT_REALTIME_MODEL}
                value={config.onpremRealtimeModel}
                onChange={(event) => update({ onpremRealtimeModel: event.target.value })}
              />
            )}
          </Field>
          <IceServersField
            id={id('ice-servers')}
            servers={config.realtimeIceServers}
            error={errorAt(errors, 'realtimeIceServers')}
            onChange={(realtimeIceServers) => update({ realtimeIceServers })}
          />
          <Field
            id={id('turn-auth')}
            label={t('transcription.recording.admin.realtimeTurnAuth.label')}
            hint={t('transcription.recording.admin.realtimeTurnAuth.hint')}
            error={errors.realtimeTurnAuth}
          >
            {(control) => (
              <Select
                value={config.realtimeTurnAuth}
                onValueChange={(value) =>
                  update({ realtimeTurnAuth: value as TranscriptionTurnAuth })
                }
              >
                <SelectTrigger {...control}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TRANSCRIPTION_TURN_AUTH.map((auth) => (
                    <SelectItem key={auth} value={auth}>
                      {t(`transcription.recording.admin.realtimeTurnAuth.${auth}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
          {config.realtimeTurnAuth === 'ephemeral' ? (
            <NumberField
              id={id('turn-credential-seconds')}
              name="realtimeTurnCredentialSeconds"
              value={config.realtimeTurnCredentialSeconds}
              min={60}
              max={86_400}
              error={errors.realtimeTurnCredentialSeconds}
              onChange={(value) => update({ realtimeTurnCredentialSeconds: value ?? Number.NaN })}
            />
          ) : null}
          <ConnectionTest
            target="realtimeOnprem"
            disabled={!config.onpremSignalingUrl}
            request={() => ({
              target: 'realtimeOnprem',
              bridgeUrl: config.onpremSignalingUrl ?? undefined,
              gatewayUrl: config.onpremGatewayUrl,
              // The gateway takes the speech recognition key.
              apiKey: draftKey(secrets.apiKey),
              model: config.onpremRealtimeModel.trim() || undefined
            })}
          />
          <UrlField
            id={id('openai-realtime-url')}
            name="openaiRealtimeUrl"
            value={config.openaiRealtimeUrl}
            placeholder="https://api.openai.com/v1"
            error={errors.openaiRealtimeUrl}
            // Required: an emptied field fails validation rather than turning into "not set".
            onChange={(value) => update({ openaiRealtimeUrl: value ?? '' })}
          />
          <Field
            id={id('openai-realtime-model')}
            label={t('transcription.recording.admin.openaiRealtimeModel.label')}
            hint={t('transcription.recording.admin.openaiRealtimeModel.hint')}
            error={errors.openaiRealtimeModel}
          >
            {(control) => (
              <Input
                {...control}
                maxLength={200}
                spellCheck={false}
                autoComplete="off"
                placeholder="gpt-realtime-whisper"
                value={config.openaiRealtimeModel}
                onChange={(event) => update({ openaiRealtimeModel: event.target.value })}
              />
            )}
          </Field>
          <ConnectionTest
            target="realtimeOpenai"
            disabled={!config.openaiRealtimeUrl}
            request={() => ({
              target: 'realtimeOpenai',
              url: config.openaiRealtimeUrl || undefined,
              apiKey: draftKey(secrets.openaiRealtimeApiKey),
              model: config.openaiRealtimeModel.trim() || undefined
            })}
          />
        </div>
      </PanelSection>

      <PanelSection
        title={t('transcription.recording.admin.sections.storage')}
        hint={t('transcription.recording.admin.storageHint')}
      >
        <ConnectionTest target="storage" request={() => ({ target: 'storage' })} />
      </PanelSection>
    </>
  )
}

type UrlFieldName =
  | 'asrBaseUrl'
  | 'diarizationUrl'
  | 'llmBaseUrl'
  | 'onpremSignalingUrl'
  | 'onpremGatewayUrl'
  | 'openaiRealtimeUrl'

function UrlField({
  id,
  name,
  value,
  error,
  placeholder = 'https://',
  onChange
}: {
  id: string
  name: UrlFieldName
  value: string | null
  error: string | undefined
  placeholder?: string
  onChange: (value: string | null) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Field
      id={id}
      label={t(`transcription.recording.admin.${name}.label`)}
      hint={t(`transcription.recording.admin.${name}.hint`)}
      error={error}
    >
      {(control) => (
        <Input
          {...control}
          // The speech address may list several workers, comma-separated, which `url` refuses.
          type={name === 'asrBaseUrl' ? 'text' : 'url'}
          inputMode="url"
          spellCheck={false}
          placeholder={placeholder}
          value={value ?? ''}
          onChange={(event) => onChange(urlOrNull(event.target.value))}
        />
      )}
    </Field>
  )
}

function SwitchField({
  id,
  name,
  checked,
  onChange
}: {
  id: string
  name: 'diarizationEnabled' | 'defaultLlmCorrection' | 'llmDisableThinking'
  checked: boolean
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <FormItem>
      <div className="flex items-center justify-between gap-stack-md">
        <Label htmlFor={id}>{t(`transcription.recording.admin.${name}.label`)}</Label>
        <Switch
          id={id}
          checked={checked}
          aria-describedby={`${id}-hint`}
          onCheckedChange={onChange}
        />
      </div>
      <FormDescription id={`${id}-hint`}>
        {t(`transcription.recording.admin.${name}.hint`)}
      </FormDescription>
    </FormItem>
  )
}

type NumberFieldName =
  | 'maxFileMegabytes'
  | 'maxDurationMinutes'
  | 'maxFilesPerGroup'
  | 'maxActiveJobsPerUser'
  | 'workerConcurrency'
  | 'asrConcurrency'
  | 'chunkSeconds'
  | 'upstreamTimeoutSeconds'
  | 'transcriptRetentionHours'
  | 'unsavedJobRetentionHours'
  | 'realtimeTurnCredentialSeconds'

/**
 * A whole number. An empty field is `null` where that means "no limit" (`nullable`); elsewhere it
 * becomes `NaN`, which the form's validation reports at the field.
 */
function NumberField({
  id,
  name,
  value,
  min,
  max,
  nullable = false,
  hintValues,
  error,
  onChange
}: {
  id: string
  name: NumberFieldName
  value: number | null
  min: number
  max?: number
  nullable?: boolean
  hintValues?: Record<string, number>
  error: string | undefined
  onChange: (value: number | null) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Field
      id={id}
      label={t(`transcription.recording.admin.${name}.label`)}
      hint={t(`transcription.recording.admin.${name}.hint`, hintValues)}
      error={error}
    >
      {(control) => (
        <Input
          {...control}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          required={!nullable}
          value={value === null || Number.isNaN(value) ? '' : String(value)}
          onChange={(event) => {
            const text = event.target.value.trim()
            onChange(text === '' ? (nullable ? null : Number.NaN) : Number(text))
          }}
        />
      )}
    </Field>
  )
}

/**
 * The models offered from an endpoint (T-63): id and display name per row, added by hand or
 * fetched from the endpoint's `GET /models` with the key as typed in the form.
 */
function ModelList({
  id,
  kind,
  field,
  config,
  latest,
  onChange,
  errors,
  apiKey
}: {
  id: string
  kind: TranscriptionModelKind
  field: ModelField
  config: Config
  latest: React.RefObject<Config>
  onChange: (config: Config) => void
  errors: Partial<Record<string, string>>
  apiKey: string | null | undefined
}): React.JSX.Element {
  const { t } = useTranslation()
  const fetchModels = useFetchAdminModels()
  const [status, setStatus] = useState<
    | { kind: 'fetched'; count: number; omitted: number; leftOut: number }
    | { kind: 'noneOfKind'; leftOut: number }
    | { kind: 'empty' | 'invalidUrl' | 'failed' }
    | null
  >(null)
  const models = config[field]
  // Several speech workers serve the same models: the first is asked.
  const baseUrl =
    kind === 'asr' ? (transcriptionUrls(config.asrBaseUrl)[0] ?? null) : config.llmBaseUrl
  const groupError = errors[field]

  const load = (): void => {
    if (!baseUrl) return
    setStatus(null)
    fetchModels.mutate(
      { kind, baseUrl, apiKey },
      {
        onSuccess: (fetched) => {
          const current = latest.current
          // The address changed meanwhile; these models belong to the old one.
          const now =
            kind === 'asr' ? (transcriptionUrls(current.asrBaseUrl)[0] ?? null) : current.llmBaseUrl
          if (now !== baseUrl) return
          if (fetched.models.length === 0) {
            setStatus(
              fetched.leftOut > 0
                ? { kind: 'noneOfKind', leftOut: fetched.leftOut }
                : { kind: 'empty' }
            )
            return
          }
          const result = withFetchedModels(current, field, fetched.models)
          onChange(result.config)
          setStatus({
            kind: 'fetched',
            count: result.config[field].length,
            omitted: result.omitted,
            leftOut: fetched.leftOut
          })
        },
        onError: (error) =>
          setStatus({
            kind:
              error instanceof ApiRequestError && error.code === 'validation'
                ? 'invalidUrl'
                : 'failed'
          })
      }
    )
  }

  const setModel = (index: number, model: TranscriptionModel): void => {
    const previous = models[index]
    const next = models.map((current, i) => (i === index ? model : current))
    onChange(
      withModels(
        config,
        field,
        next,
        previous && previous.id !== model.id
          ? { from: previous.id.trim(), to: model.id }
          : undefined
      )
    )
  }
  const addModel = (): void => {
    flushSync(() => onChange({ ...config, [field]: [...models, { id: '', label: '' }] }))
    document.getElementById(`${id}-${models.length}-id`)?.focus()
  }
  const removeModel = (index: number): void => {
    flushSync(() =>
      onChange(
        withModels(
          config,
          field,
          models.filter((_, i) => i !== index)
        )
      )
    )
    // The removed row took the focused button with it.
    document.getElementById(`${id}-add`)?.focus()
  }

  return (
    <FormItem error={groupError}>
      <fieldset
        aria-describedby={[groupError && `${id}-error`, `${id}-hint`].filter(Boolean).join(' ')}
        className="flex min-w-0 flex-col gap-2"
      >
        {/* DS gap: no legend for a group of fields; `Label` gives it the label's look. */}
        <Label asChild className={cn(groupError && 'text-error')}>
          <legend id={`${id}-legend`}>{t(`transcription.recording.admin.${field}.label`)}</legend>
        </Label>
        <FormMessage id={`${id}-error`} />
        {models.length > 0 ? (
          <Table aria-labelledby={`${id}-legend`}>
            <TableHeader>
              <TableRow>
                <TableHead>{t('transcription.recording.admin.modelId')}</TableHead>
                <TableHead>{t('transcription.recording.admin.modelLabel')}</TableHead>
                <TableHead>
                  <span className="sr-only">{t('transcription.recording.admin.modelActions')}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {models.map((model, index) => {
                const rowId = `${id}-${index}`
                const idError = errors[`${field}.${index}.id`]
                const labelError = errors[`${field}.${index}.label`]
                const rowName = model.label.trim() || model.id.trim() || String(index + 1)
                const removeLabel = t('transcription.recording.admin.removeModel', {
                  name: rowName
                })
                return (
                  <TableRow key={index}>
                    <TableCell>
                      <FormItem error={idError}>
                        <Label htmlFor={`${rowId}-id`} className="sr-only">
                          {t('transcription.recording.admin.modelId')}
                        </Label>
                        <Input
                          id={`${rowId}-id`}
                          value={model.id}
                          spellCheck={false}
                          autoComplete="off"
                          aria-invalid={idError ? true : undefined}
                          aria-describedby={idError ? `${rowId}-id-error` : undefined}
                          onChange={(event) =>
                            // Another id is the admin's, no longer what discovery classified.
                            setModel(index, { id: event.target.value, label: model.label })
                          }
                        />
                        <FormMessage id={`${rowId}-id-error`} />
                      </FormItem>
                    </TableCell>
                    <TableCell>
                      <FormItem error={labelError}>
                        <Label htmlFor={`${rowId}-label`} className="sr-only">
                          {t('transcription.recording.admin.modelLabel')}
                        </Label>
                        <Input
                          id={`${rowId}-label`}
                          value={model.label}
                          autoComplete="off"
                          aria-invalid={labelError ? true : undefined}
                          aria-describedby={labelError ? `${rowId}-label-error` : undefined}
                          onChange={(event) =>
                            setModel(index, { ...model, label: event.target.value })
                          }
                        />
                        <FormMessage id={`${rowId}-label-error`} />
                      </FormItem>
                    </TableCell>
                    <TableCell>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost-destructive"
                            size="icon"
                            aria-label={removeLabel}
                            onClick={() => removeModel(index)}
                          >
                            <Trash2Icon {...ICON} />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{removeLabel}</TooltipContent>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            id={`${id}-add`}
            type="button"
            variant="secondary"
            size="sm"
            disabled={models.length >= TRANSCRIPTION_MODELS_MAX}
            onClick={addModel}
          >
            <PlusIcon {...ICON} />
            {t('transcription.recording.admin.addModel')}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!baseUrl || fetchModels.isPending}
            aria-describedby={`${id}-fetch-status`}
            onClick={load}
          >
            <DownloadIcon {...ICON} />
            {fetchModels.isPending
              ? t('transcription.recording.admin.fetchingModels')
              : t('transcription.recording.admin.fetchModels')}
          </Button>
        </div>
        {/* Its own item: the group's error is not the fetch's. */}
        <FormItem id={`${id}-fetch-status`} aria-live="polite" className="empty:hidden">
          {status?.kind === 'fetched' ? (
            <FormDescription>
              {[
                t('transcription.recording.admin.fetchedModels', { count: status.count }),
                status.omitted > 0
                  ? t('transcription.recording.admin.fetchedModelsOmitted', {
                      count: status.omitted,
                      max: TRANSCRIPTION_MODELS_MAX
                    })
                  : null,
                status.leftOut > 0
                  ? t(`transcription.recording.admin.fetchedModelsLeftOut.${kind}`, {
                      count: status.leftOut
                    })
                  : null
              ]
                .filter(Boolean)
                .join(' ')}
            </FormDescription>
          ) : status?.kind === 'noneOfKind' ? (
            <FormMessage>
              {t(`transcription.recording.admin.fetchModelsErrors.noneOfKind.${kind}`, {
                count: status.leftOut
              })}
            </FormMessage>
          ) : status ? (
            <FormMessage>
              {t(`transcription.recording.admin.fetchModelsErrors.${status.kind}`)}
            </FormMessage>
          ) : null}
        </FormItem>
        <FormDescription id={`${id}-hint`}>
          {t(`transcription.recording.admin.${field}.hint`, { max: TRANSCRIPTION_MODELS_MAX })}
        </FormDescription>
      </fieldset>
    </FormItem>
  )
}

function DefaultModelSelect({
  id,
  name,
  models,
  value,
  error,
  onChange
}: {
  id: string
  name: DefaultModelField
  models: readonly TranscriptionModel[]
  value: string | null
  error: string | undefined
  onChange: (value: string | null) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Field
      id={id}
      label={t(`transcription.recording.admin.${name}.label`)}
      hint={t(`transcription.recording.admin.${name}.hint`)}
      error={error}
    >
      {(control) => (
        <Select
          value={value ?? AUTO}
          onValueChange={(next) => onChange(next === AUTO ? null : next)}
        >
          <SelectTrigger {...control}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={AUTO}>
              {t(
                name === 'defaultAsrModel'
                  ? 'transcription.recording.admin.firstSpeechModel'
                  : 'transcription.recording.admin.firstModel'
              )}
            </SelectItem>
            {value !== null && !models.some((model) => model.id.trim() === value) ? (
              <SelectItem value={value}>
                {t('transcription.recording.admin.unlistedModel', { id: value })}
              </SelectItem>
            ) : null}
            {models.map((model, index) =>
              model.id.trim() ? (
                <SelectItem key={index} value={model.id.trim()}>
                  {model.label.trim() || model.id}
                </SelectItem>
              ) : null
            )}
          </SelectContent>
        </Select>
      )}
    </Field>
  )
}

/** The live modes offered (T-59), in the contract's order. */
function RealtimeModesField({
  id,
  modes,
  error,
  onChange
}: {
  id: string
  modes: readonly TranscriptionRealtimeMode[]
  error: string | undefined
  onChange: (modes: TranscriptionRealtimeMode[]) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <FormItem error={error}>
      <fieldset
        aria-describedby={[error && `${id}-error`, `${id}-hint`].filter(Boolean).join(' ')}
        className="flex min-w-0 flex-col gap-2"
      >
        {/* DS gap: no legend for a group of fields; `Label` gives it the label's look. */}
        <Label asChild className={cn(error && 'text-error')}>
          <legend>{t('transcription.recording.admin.realtimeModes.label')}</legend>
        </Label>
        <FormMessage id={`${id}-error`} />
        {TRANSCRIPTION_REALTIME_MODES.map((mode) => (
          <div key={mode} className="flex items-center gap-2">
            <Checkbox
              id={`${id}-${mode}`}
              checked={modes.includes(mode)}
              onCheckedChange={(checked) =>
                onChange(
                  TRANSCRIPTION_REALTIME_MODES.filter((option) =>
                    option === mode ? checked === true : modes.includes(option)
                  )
                )
              }
            />
            <Label htmlFor={`${id}-${mode}`}>
              {t(`transcription.recording.admin.modes.${mode}`)}
            </Label>
          </div>
        ))}
        <FormDescription id={`${id}-hint`}>
          {t('transcription.recording.admin.realtimeModes.hint')}
        </FormDescription>
      </fieldset>
    </FormItem>
  )
}

function serversToText(servers: readonly TranscriptionIceServer[]): string {
  return servers.map((server) => server.urls.join(' ')).join('\n')
}

function textToServers(text: string): TranscriptionIceServer[] {
  return text
    .split('\n')
    .map((line) => line.split(/[\s,]+/).filter(Boolean))
    .filter((urls) => urls.length > 0)
    .map((urls) => ({ urls }))
}

/** One ICE server per line; the text stays as typed while the config gets the parsed servers. */
function IceServersField({
  id,
  servers,
  error,
  onChange
}: {
  id: string
  servers: readonly TranscriptionIceServer[]
  error: string | undefined
  onChange: (servers: TranscriptionIceServer[]) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [text, setText] = useState(() => serversToText(servers))
  // A config replaced from outside (another component opened) shows its own servers.
  const parsed = serversToText(textToServers(text))
  const outside = serversToText(servers)
  const shown = parsed === outside ? text : outside

  return (
    <Field
      id={id}
      label={t('transcription.recording.admin.iceServers.label')}
      hint={t('transcription.recording.admin.iceServers.hint')}
      error={error}
    >
      {(control) => (
        <Textarea
          {...control}
          rows={3}
          spellCheck={false}
          placeholder="stun:stun.uni-giessen.de:3478"
          value={shown}
          onChange={(event) => {
            setText(event.target.value)
            onChange(textToServers(event.target.value))
          }}
        />
      )}
    </Field>
  )
}

/**
 * Checks one upstream with the values in the form, by doing what the module does with it; the
 * answer lists each step and never contains a key.
 */
function ConnectionTest({
  target,
  request,
  disabled = false
}: {
  target: TranscriptionConnectionTarget
  request: () => TranscriptionConnectionTestRequest
  disabled?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const test = useTestAdminConnection()
  const [result, setResult] = useState<TranscriptionConnectionTest | 'error' | null>(null)
  const statusId = useId()
  /** One step of the test in the admin's language. */
  const findingText = (finding: TranscriptionConnectionFinding): string =>
    finding.kind === 'invalidAnswer'
      ? t(`transcription.recording.admin.test.findings.invalidAnswer.${finding.expected}`)
      : finding.kind === 'realtimeUnavailable'
        ? t(`transcription.recording.admin.test.findings.realtimeUnavailable.${finding.reason}`, {
            model: finding.model
          })
        : t(`transcription.recording.admin.test.findings.${finding.kind}`, finding)

  const run = (): void => {
    setResult(null)
    test.mutate(request(), {
      onSuccess: setResult,
      onError: () => setResult('error')
    })
  }

  let detail: ReactNode = null
  if (result === 'error')
    detail = <FormMessage>{t('transcription.recording.admin.test.error')}</FormMessage>
  else if (result) {
    const facts = [
      result.ok
        ? t('transcription.recording.admin.test.ok')
        : t('transcription.recording.admin.test.failed'),
      result.status !== null
        ? t('transcription.recording.admin.test.status', { status: result.status })
        : null,
      result.latencyMs !== null
        ? t('transcription.recording.admin.test.latency', { ms: result.latencyMs })
        : null,
      ...(result.checks.length > 0 ? result.checks : result.finding ? [result.finding] : []).map(
        findingText
      ),
      result.message
    ]
      .filter(Boolean)
      .join(' · ')
    detail = result.ok ? (
      <FormDescription>{facts}</FormDescription>
    ) : (
      <FormMessage>{facts}</FormMessage>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || test.isPending}
          aria-describedby={statusId}
          onClick={run}
        >
          <PlugZapIcon {...ICON} />
          {test.isPending
            ? t('transcription.recording.admin.test.running')
            : t(`transcription.recording.admin.testTargets.${target}`)}
        </Button>
      </div>
      <FormItem id={statusId} aria-live="polite" className="empty:hidden">
        {detail}
      </FormItem>
    </div>
  )
}
