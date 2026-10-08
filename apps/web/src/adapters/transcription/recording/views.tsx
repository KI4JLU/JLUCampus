import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleIcon,
  DownloadIcon,
  MicIcon,
  MonitorUpIcon,
  RadioIcon,
  SquareIcon,
  Trash2Icon,
  UploadIcon,
  XIcon
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardTitle,
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
import { BackupFailedNotice, LeftoverNotices } from './backup-views'
import { useRecording, type RecordedTake, type RecordedTrack } from './context'
import { useElapsedSeconds, useRecordingStatusTexts } from './hooks'
import { SourceControls, SourceNotices } from './source-views'
import { isRecordingBusy, type RecordingKind } from './state'

const ICON = { 'aria-hidden': true, className: 'size-4' } as const

/**
 * Regular recording and live transcription as tabs of one work area, as in kiChat. While something
 * records, the other tab stays closed; live transcription needs a live mode, recording needs
 * speech recognition to upload to.
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
  const Icon = kind === 'live' ? RadioIcon : MicIcon
  return <Icon aria-hidden="true" className={className} />
}

/** Title and hint of the recording state (kiChat's status in the middle of the card). */
export function RecordingStatusCard({ kind }: { kind: RecordingKind }): React.JSX.Element {
  const texts = useRecordingStatusTexts()
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

/**
 * Start and stop, uploading the takes, and the sources with the "+" beside them (kiChat's bar under
 * the card). Live transcription lists its one microphone, and the "+" switches it.
 */
export function RecordingControls({ kind }: { kind: RecordingKind }): React.JSX.Element {
  const { t } = useTranslation()
  const { capabilities } = useTranscriptionWorkspace()
  const { state, takes, start, stop, uploadTakes, live, microphones } = useRecording()
  const id = useId()
  const { requestAccess } = microphones
  // Opening the tab asks for the microphone, so the "+" lists the devices by name.
  useEffect(() => requestAccess(), [requestAccess])
  const status = state.status
  const running = status === 'recording'
  const pending = status === 'requesting' || status === 'stopping'
  const unavailable = kind === 'live' && live.mode === null
  const batch = capabilities?.batch ?? false
  // While stopping, kiChat's disabled button reads "Aufnahme starten"; the spinner still tells
  // screen readers that the take is being finished.
  const label = running
    ? t('transcription.recording.stopRecording')
    : status === 'requesting'
      ? state.step === 'connecting'
        ? t('transcription.recording.connecting')
        : t('transcription.recording.grantMicrophone')
      : t('transcription.recording.startRecording')
  const busyLabel = status === 'stopping' ? t('transcription.recording.recordingStopping') : label

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
              <Spinner size="sm" label={busyLabel} />
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
        <SourceControls kind={kind} />
        {!batch && takes.length > 0 ? (
          <p id={`${id}-upload-hint`} className="m-0 basis-full">
            {t('transcription.recording.uploadUnavailable')}
          </p>
        ) : null}
        {kind === 'record' ? <SourceNotices /> : null}
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
      <CardContent className="pt-6">
        <ul
          aria-label={t('transcription.recording.takesTitle')}
          className="m-0 flex list-none flex-col gap-stack-md p-0"
        >
          {takes.map((take) => (
            <TakeItem key={take.id} take={take} />
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}

/** Saves `file` under its own name through the browser's download. */
function download(file: File): void {
  const url = URL.createObjectURL(file)
  const link = document.createElement('a')
  link.href = url
  link.download = file.name
  document.body.append(link)
  link.click()
  link.remove()
  // Some browsers read the URL after the click returned.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * A take: the mix, which is what is uploaded, and below it each source's own track when it had
 * several at once.
 */
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
  // WebM over 20 minutes is not decoded, however small its file.
  const decoded = decodesLocally(take.file, take.duration)

  const arm = (): void => {
    setArmed(true)
    requestAnimationFrame(() => confirmRef.current?.focus())
  }
  const disarm = (): void => {
    setArmed(false)
    requestAnimationFrame(() => trashRef.current?.focus())
  }

  return (
    <li className="flex flex-col gap-stack-sm">
      <div className="flex flex-wrap items-center gap-stack-sm">
        <div className="flex min-w-64 flex-1 flex-col gap-1">
          <WaveformPlayer source={take.file} name={name} knownDuration={take.duration} />
          {decoded ? null : <p className="m-0">{t('transcription.recording.waveformSkipped')}</p>}
        </div>
        <div className="flex items-center gap-1">
          <IconButton label={downloadLabel} onClick={() => download(take.file)}>
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
                variant="destructive"
                onClick={() => deleteTake(take.id)}
              >
                <CheckIcon {...ICON} />
              </IconButton>
              <IconButton label={cancelLabel} onClick={disarm}>
                <XIcon {...ICON} />
              </IconButton>
            </div>
          ) : (
            <IconButton ref={trashRef} label={deleteLabel} onClick={arm}>
              <Trash2Icon {...ICON} />
            </IconButton>
          )}
        </div>
      </div>
      {take.tracks ? <TrackList name={name} tracks={take.tracks} /> : null}
    </li>
  )
}

/**
 * The tracks of a take, one per source, open from the start and closable; the mix above is what
 * they make together.
 */
function TrackList({
  name,
  tracks
}: {
  name: string
  tracks: readonly RecordedTrack[]
}): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(true)
  const id = useId()
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon
  return (
    <div className="flex flex-col gap-stack-sm">
      <div className="flex flex-wrap items-center gap-stack-sm">
        <Badge tone="info">
          {t('transcription.recording.tracks.count', { count: tracks.length })}
        </Badge>
        {/* DS gap: no Collapsible or Accordion; a button with `aria-expanded` shows the tracks. */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          onClick={() => setOpen(!open)}
        >
          <Chevron {...ICON} />
          {open
            ? t('transcription.recording.tracks.hide')
            : t('transcription.recording.tracks.show')}
        </Button>
      </div>
      {open ? (
        <ul
          id={id}
          aria-label={t('transcription.recording.tracks.listLabel', { name })}
          className="m-0 flex list-none flex-col gap-stack-sm p-0"
        >
          {tracks.map((track, index) => (
            <TrackItem key={track.id} track={track} number={index + 1} />
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/** One source's track: what it is, where it starts in the take, its player and its download. */
function TrackItem({ track, number }: { track: RecordedTrack; number: number }): React.JSX.Element {
  const { t } = useTranslation()
  const Icon = track.kind === 'display' ? MonitorUpIcon : MicIcon
  const decoded = decodesLocally(track.file, track.duration)
  return (
    <li className="flex flex-wrap items-center gap-stack-sm">
      <Icon {...ICON} />
      <div className="flex min-w-64 flex-1 flex-col gap-1">
        <WaveformPlayer source={track.file} name={track.label} knownDuration={track.duration} />
        {track.offset >= 1 ? (
          <p className="m-0">
            {t('transcription.recording.tracks.from', { time: formatTime(track.offset) })}
          </p>
        ) : null}
        {decoded ? null : <p className="m-0">{t('transcription.recording.waveformSkipped')}</p>}
      </div>
      <IconButton
        label={t('transcription.recording.tracks.download', { number, name: track.label })}
        onClick={() => download(track.file)}
      >
        <DownloadIcon {...ICON} />
      </IconButton>
    </li>
  )
}

function IconButton({
  label,
  variant = 'secondary',
  onClick,
  children,
  ref
}: {
  label: string
  variant?: 'secondary' | 'destructive'
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

/**
 * The work area of the `record` view, with the tab to live transcription (T-56 to T-58), and the
 * recordings a crash left in the backup.
 */
export function RecordView(): React.JSX.Element {
  return (
    <RecordingTabs current="record">
      <LeftoverNotices />
      <BackupFailedNotice />
      <RecordingStatusCard kind="record" />
      <RecordingControls kind="record" />
      <TakeList />
    </RecordingTabs>
  )
}
