import { useId, useRef, useState, type ReactNode } from 'react'
import {
  CheckIcon,
  CircleIcon,
  DownloadIcon,
  MicIcon,
  RadioIcon,
  SquareIcon,
  Trash2Icon,
  UploadIcon,
  UsersIcon,
  XIcon
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Label,
  PanelSection,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '@ki4jlu/design-system'
import { decodesLocally, formatTime, WaveformPlayer } from '../audio'
import { Notice } from '../notice'
import { useTranscriptionWorkspace } from '../use-workspace'
import { useRecording, type RecordedTake } from './context'
import { DEFAULT_DEVICE_ID } from './devices'
import { useElapsedSeconds, useRecordingStatusTexts } from './hooks'
import { isRecordingBusy, type RecordingKind } from './state'

const ICON = { 'aria-hidden': true, className: 'size-4' } as const

/** Radix Select takes no empty value; this one stands for the browser's default input. */
const DEFAULT_OPTION = '__default__'

/**
 * Regular recording, live transcription and meetings as tabs of one work area, as in kiChat. While
 * something records, the other tabs stay closed; live transcription needs a live mode, recording
 * and meetings need speech recognition to upload to.
 */
export function RecordingTabs({
  current,
  children
}: {
  current: RecordingKind
  children: ReactNode
}): React.JSX.Element {
  const { t } = useTranslation()
  const { capabilities, setView } = useTranscriptionWorkspace()
  const { state } = useRecording()
  const busy = isRecordingBusy(state.status)
  const tabs: { kind: RecordingKind; label: string; available: boolean }[] = [
    {
      kind: 'record',
      label: t('transcription.common.tabRecord'),
      available: capabilities?.batch ?? false
    },
    {
      kind: 'live',
      label: t('transcription.common.tabLiveTranscription'),
      available: (capabilities?.realtimeModes.length ?? 0) > 0
    },
    {
      kind: 'meeting',
      label: t('transcription.recording.meeting.tab'),
      available: capabilities?.batch ?? false
    }
  ]

  return (
    <Tabs
      value={current}
      onValueChange={(value) => setView(tabs.find((tab) => tab.kind === value)?.kind ?? 'record')}
      activationMode="manual"
    >
      <TabsList aria-label={t('transcription.recording.tabsLabel')}>
        {tabs.map((tab) => (
          <TabsTrigger
            key={tab.kind}
            value={tab.kind}
            disabled={tab.kind !== current && (busy || !tab.available)}
          >
            <KindIcon kind={tab.kind} className="size-4" />
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value={current} className="flex flex-col gap-stack-lg">
        {children}
      </TabsContent>
    </Tabs>
  )
}

function KindIcon({
  kind,
  className
}: {
  kind: RecordingKind
  className: string
}): React.JSX.Element {
  const Icon = kind === 'live' ? RadioIcon : kind === 'meeting' ? UsersIcon : MicIcon
  return <Icon aria-hidden="true" className={className} />
}

/** Title and hint of the recording state (kiChat's status in the middle of the card). */
export function RecordingStatusCard({ kind }: { kind: RecordingKind }): React.JSX.Element {
  const texts = useRecordingStatusTexts(kind)
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-stack-md py-12 text-center">
        <KindIcon kind={kind} className="size-10" />
        <div aria-live="polite" className="flex flex-col items-center gap-2">
          <CardTitle asChild>
            <h2>{texts.title}</h2>
          </CardTitle>
          {texts.error ? null : <CardDescription>{texts.text}</CardDescription>}
        </div>
        {texts.error ? (
          <Notice tone="error" inline className="max-w-xl justify-center">
            {texts.text}
          </Notice>
        ) : null}
      </CardContent>
    </Card>
  )
}

/** The running time of the recording; a timer, so screen readers do not announce every second. */
function ElapsedBadge(): React.JSX.Element | null {
  const { t } = useTranslation()
  const { state } = useRecording()
  const running = state.status === 'recording'
  const elapsed = useElapsedSeconds(running ? state.startedAt : null)
  if (!running) return null
  return (
    <span role="timer">
      <Badge tone="error">
        <CircleIcon aria-hidden="true" className="size-2 fill-current" />
        {t('transcription.recording.elapsed', { time: formatTime(elapsed) })}
      </Badge>
    </span>
  )
}

/** The shared microphone choice (T-55): default input first, locked while busy. */
export function DeviceSelect({
  id,
  compact = false
}: {
  id: string
  /** The side column's wording while devices load. */
  compact?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const { state, microphones } = useRecording()
  const busy = isRecordingBusy(state.status)
  const unavailable =
    microphones.list === 'loading'
      ? compact
        ? t('transcription.recording.searchingDevices')
        : t('transcription.recording.loadingMicrophones')
      : microphones.list === 'unsupported'
        ? t('transcription.recording.microphoneAccessUnsupported')
        : microphones.list === 'failed'
          ? t('transcription.recording.microphonesUnavailable')
          : null

  if (unavailable)
    return (
      <Select disabled value="">
        <SelectTrigger id={id}>
          <SelectValue placeholder={unavailable} />
        </SelectTrigger>
        <SelectContent />
      </Select>
    )

  const value = microphones.selected === DEFAULT_DEVICE_ID ? DEFAULT_OPTION : microphones.selected
  return (
    <Select
      disabled={busy}
      value={value}
      onValueChange={(next) =>
        microphones.select(next === DEFAULT_OPTION ? DEFAULT_DEVICE_ID : next)
      }
    >
      <SelectTrigger id={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={DEFAULT_OPTION}>
          {t('transcription.recording.defaultMicrophone')}
        </SelectItem>
        {microphones.choices.map((choice) => (
          <SelectItem key={choice.deviceId} value={choice.deviceId}>
            {choice.label ?? t('transcription.recording.microphoneN', { n: choice.number })}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** Start and stop, uploading the takes, and the microphone (kiChat's bar under the card). */
export function RecordingControls({ kind }: { kind: RecordingKind }): React.JSX.Element {
  const { t } = useTranslation()
  const { capabilities } = useTranscriptionWorkspace()
  const { state, takes, start, stop, uploadTakes, live, meeting } = useRecording()
  const id = useId()
  const status = state.status
  const running = status === 'recording'
  const pending = status === 'requesting' || status === 'stopping'
  // A meeting starts only where tab audio can be shared, and after everyone agreed.
  const unavailable =
    kind === 'live'
      ? live.mode === null
      : kind === 'meeting'
        ? meeting.support !== 'supported' || !meeting.consented
        : false
  const batch = capabilities?.batch ?? false
  const label = running
    ? t('transcription.recording.stopRecording')
    : status === 'requesting'
      ? state.step === 'connecting'
        ? t('transcription.recording.connecting')
        : state.step === 'display'
          ? t('transcription.recording.meeting.selectTab')
          : t('transcription.recording.grantMicrophone')
      : status === 'stopping'
        ? t('transcription.recording.recordingStopping')
        : t('transcription.recording.startRecording')

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-stack-md pt-6">
        <div className="flex flex-wrap items-center gap-stack-sm">
          <Button
            type="button"
            variant="destructive"
            disabled={pending || (!running && unavailable)}
            onClick={() => void (running ? stop() : start(kind))}
          >
            {pending ? (
              <Spinner size="sm" label={label} />
            ) : running ? (
              <SquareIcon aria-hidden="true" className="size-3 fill-current" />
            ) : (
              <CircleIcon aria-hidden="true" className="size-3 fill-current" />
            )}
            {label}
          </Button>
          <ElapsedBadge />
          {!isRecordingBusy(status) && takes.length > 0 ? (
            <Button
              type="button"
              variant="outline"
              disabled={!batch}
              aria-describedby={batch ? undefined : `${id}-upload-hint`}
              onClick={uploadTakes}
            >
              <UploadIcon {...ICON} />
              {t('transcription.recording.uploadForTranscription')}
            </Button>
          ) : null}
        </div>
        <div className="flex min-w-56 flex-1 flex-col gap-1 sm:max-w-sm">
          <Label htmlFor={`${id}-device`} className="sr-only">
            {t('transcription.recording.microphone')}
          </Label>
          <DeviceSelect id={`${id}-device`} />
        </div>
        {!batch && takes.length > 0 ? (
          <p id={`${id}-upload-hint`} className="m-0 basis-full">
            {t('transcription.recording.uploadUnavailable')}
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}

/**
 * The recorded takes of all tabs (T-57): one player each with waveform, time and duration, a
 * download, and a delete that asks once more. They stay until uploaded or deleted.
 */
export function TakeList(): React.JSX.Element | null {
  const { t } = useTranslation()
  const { takes } = useRecording()
  if (takes.length === 0) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle asChild>
          <h2>{t('transcription.recording.takesTitle')}</h2>
        </CardTitle>
        <CardDescription>{t('transcription.recording.takesHint')}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="m-0 flex list-none flex-col gap-stack-md p-0">
          {takes.map((take) => (
            <TakeItem key={take.id} take={take} />
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

function TakeItem({ take }: { take: RecordedTake }): React.JSX.Element {
  const { t } = useTranslation()
  const { deleteTake } = useRecording()
  const [armed, setArmed] = useState(false)
  const trashRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const name = take.file.name
  const downloadLabel = t('transcription.recording.downloadRecordingName', { name })
  const deleteLabel = t('transcription.recording.deleteRecordingName', { name })
  const confirmLabel = t('transcription.recording.confirmDeleteRecording', { name })
  const cancelLabel = t('transcription.recording.cancelDeleteRecording', { name })
  // A meeting over 20 minutes is not decoded, however small its file.
  const decoded = decodesLocally(take.file, take.duration)

  const download = (): void => {
    const url = URL.createObjectURL(take.file)
    const link = document.createElement('a')
    link.href = url
    link.download = name
    document.body.append(link)
    link.click()
    link.remove()
    // Some browsers read the URL after the click returned.
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const arm = (): void => {
    setArmed(true)
    requestAnimationFrame(() => confirmRef.current?.focus())
  }
  const disarm = (): void => {
    setArmed(false)
    requestAnimationFrame(() => trashRef.current?.focus())
  }

  return (
    <li className="flex flex-wrap items-center gap-stack-sm">
      <div className="flex min-w-64 flex-1 flex-col gap-1">
        <WaveformPlayer source={take.file} name={name} knownDuration={take.duration} />
        {decoded ? null : (
          <p className="m-0">{t('transcription.recording.meeting.waveformSkipped')}</p>
        )}
      </div>
      <div className="flex items-center gap-1">
        <IconButton label={downloadLabel} onClick={download}>
          <DownloadIcon {...ICON} />
        </IconButton>
        {armed ? (
          <div
            role="group"
            aria-label={deleteLabel}
            className="flex items-center gap-1"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation()
                disarm()
              }
            }}
          >
            <IconButton
              ref={confirmRef}
              label={confirmLabel}
              variant="ghost-destructive"
              onClick={() => deleteTake(take.id)}
            >
              <CheckIcon {...ICON} />
            </IconButton>
            <IconButton label={cancelLabel} onClick={disarm}>
              <XIcon {...ICON} />
            </IconButton>
          </div>
        ) : (
          <IconButton ref={trashRef} label={deleteLabel} variant="ghost-destructive" onClick={arm}>
            <Trash2Icon {...ICON} />
          </IconButton>
        )}
      </div>
    </li>
  )
}

function IconButton({
  label,
  variant = 'ghost',
  onClick,
  children,
  ref
}: {
  label: string
  variant?: 'ghost' | 'ghost-destructive'
  onClick: () => void
  children: ReactNode
  ref?: React.Ref<HTMLButtonElement>
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          ref={ref}
          type="button"
          variant={variant}
          size="icon"
          aria-label={label}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/** The work area of the `record` view, with the tab to live transcription (T-56 to T-58). */
export function RecordView(): React.JSX.Element {
  return (
    <RecordingTabs current="record">
      <RecordingStatusCard kind="record" />
      <RecordingControls kind="record" />
      <TakeList />
    </RecordingTabs>
  )
}

/** The side column of the `record` view: the status and the microphone, as in kiChat. */
export function RecordingSettings({
  kind = 'record'
}: {
  /** The view's tab, for its status at rest. */
  kind?: RecordingKind
}): React.JSX.Element {
  const { t } = useTranslation()
  const id = useId()
  const texts = useRecordingStatusTexts(kind)
  return (
    <>
      <PanelSection title={t('transcription.common.statusLabel')}>
        <p className="m-0">{texts.title}</p>
        {texts.error ? (
          <Notice tone="error" inline>
            {texts.text}
          </Notice>
        ) : (
          <p className="m-0">{texts.text}</p>
        )}
      </PanelSection>
      <PanelSection
        title={<Label htmlFor={`${id}-device`}>{t('transcription.recording.microphone')}</Label>}
      >
        <DeviceSelect id={`${id}-device`} compact />
      </PanelSection>
    </>
  )
}
