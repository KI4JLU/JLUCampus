import { useRef, useState } from 'react'
import { MicIcon, MonitorUpIcon, PlusIcon, XIcon, type LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@ki4jlu/design-system'
import { cn } from '@/lib/utils'
import { Notice } from '../notice'
import { IconButton } from '../result/icon-button'
import { useRecording, type MicrophoneOption } from './context'
import { MAIN_SOURCE_ID, type RecordingSource } from './sources'
import { areSourcesLocked, isRecordingBusy, type RecordingKind } from './state'
import { useAudioActivity } from './use-audio-activity'

const ICON = { 'aria-hidden': true, className: 'size-4' } as const
/** How long the "+" menu waits on a highlighted microphone before opening it for its icon. */
const PREVIEW_DELAY_MS = 150

/**
 * A source's icon, lit while `active`, i.e. while the source picks up sound. Decorative only: the
 * name beside it says what the source is, and nothing is announced.
 */
function LevelIcon({
  icon: Icon,
  active
}: {
  icon: LucideIcon
  active: boolean
}): React.JSX.Element {
  return (
    <Icon
      aria-hidden="true"
      // DS gap: no audio level indicator; the icon takes the primary colour while active.
      className={cn(
        'size-4 transition-colors motion-reduce:transition-none',
        active && 'text-primary'
      )}
    />
  )
}

/** A source's icon, lit while the source picks up sound (`useAudioActivity`). */
function ActivityIcon({
  icon,
  stream,
  deviceId
}: {
  icon: LucideIcon
  stream: MediaStream | null
  deviceId: string | null
}): React.JSX.Element {
  return <LevelIcon icon={icon} active={useAudioActivity(stream, deviceId)} />
}

/** Why the device list is not there, or `null` once it is. */
function useMicrophoneListProblem(): string | null {
  const { t } = useTranslation()
  const { microphones } = useRecording()
  switch (microphones.list) {
    case 'loading':
      return t('transcription.recording.loadingMicrophones')
    case 'unsupported':
      return t('transcription.recording.microphoneAccessUnsupported')
    case 'failed':
      return t('transcription.recording.microphonesUnavailable')
    case 'ready':
      return null
  }
}

/**
 * The sources and the "+" beside them. Removing a source moves the focus on to the remove button
 * now in its place, else to the "+", so the keyboard does not lose its place. Without a source a
 * placeholder, `emptyId`, says to add one.
 */
export function SourceControls({
  kind,
  emptyId
}: {
  kind: RecordingKind
  emptyId: string
}): React.JSX.Element {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const refocus = (index: number): void => {
    requestAnimationFrame(() => {
      const buttons = Array.from(listRef.current?.querySelectorAll('button') ?? [])
      const next = buttons[Math.min(index, buttons.length - 1)]
      const target = next && !next.disabled ? next : triggerRef.current
      target?.focus()
    })
  }
  return (
    <div className="flex min-w-56 flex-1 items-start gap-1 sm:max-w-sm">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <SourceList kind={kind} emptyId={emptyId} listRef={listRef} onRemoved={refocus} />
      </div>
      <AddSourceMenu kind={kind} triggerRef={triggerRef} />
    </div>
  )
}

/**
 * The "+" beside the sources. Regular recording adds a microphone not in use, or a tab, window or
 * screen, before and while recording; the tab picker opens straight from the item's click. Live
 * transcription hears one microphone and chooses or switches it instead; the "+" names the current
 * one, so a switch is heard where the focus returns. Without the device list only the browser's
 * default microphone is offered, and why the list is missing shows below it. With the microphone
 * permission the highlighted microphone's icon lights up while it picks up sound
 * (`MicrophoneItems`).
 */
function AddSourceMenu({
  kind,
  triggerRef
}: {
  kind: RecordingKind
  triggerRef: React.Ref<HTMLButtonElement>
}): React.JSX.Element {
  const { t } = useTranslation()
  const { state, sources, liveMicrophone, selectMicrophone } = useRecording()
  const problem = useMicrophoneListProblem()
  const live = kind === 'live'
  const microphones = live ? liveMicrophone.others : sources.addableMicrophones
  const choose = live ? selectMicrophone : sources.addMicrophone
  const reason =
    sources.displaySupport === 'desktop'
      ? t('transcription.recording.sources.displayUnsupportedDesktop')
      : sources.displaySupport === 'browser'
        ? t('transcription.recording.sources.displayUnsupported')
        : null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton
          ref={triggerRef}
          label={
            !live
              ? t('transcription.recording.sources.add')
              : liveMicrophone.current
                ? t('transcription.recording.sources.switchMicrophone', {
                    name: liveMicrophone.current.label
                  })
                : t('transcription.recording.sources.chooseMicrophone')
          }
          variant="outline"
          disabled={areSourcesLocked(state)}
        >
          <PlusIcon {...ICON} />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {/* DS gap: no DropdownMenuSub; the microphones are a labelled group instead. */}
        {live ? null : (
          <DropdownMenuLabel>
            {t('transcription.recording.sources.addMicrophone')}
          </DropdownMenuLabel>
        )}
        <MicrophoneItems microphones={microphones} onChoose={choose} />
        {problem || microphones.length === 0 ? (
          <DropdownMenuItem disabled>
            {problem ?? t('transcription.recording.sources.noMoreMicrophones')}
          </DropdownMenuItem>
        ) : null}
        {live ? null : (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={reason !== null} onSelect={sources.addDisplay}>
              <MonitorUpIcon {...ICON} />
              <span className="flex flex-col">
                {t('transcription.recording.sources.addDisplay')}
                {reason ? <span>{reason}</span> : null}
              </span>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The "+" menu's microphones. With the microphone permission the one highlighted by pointer or
 * keyboard is opened for its icon, shortly after it is, so passing over the others opens nothing;
 * the stream closes when the highlight moves on or the menu closes.
 */
function MicrophoneItems({
  microphones,
  onChoose
}: {
  microphones: readonly MicrophoneOption[]
  onChoose: (deviceId: string) => void
}): React.JSX.Element {
  const { microphones: devices } = useRecording()
  const [highlighted, setHighlighted] = useState<string | null>(null)
  const active = useAudioActivity(null, devices.granted ? highlighted : null, PREVIEW_DELAY_MS)
  return (
    <>
      {microphones.map(({ deviceId, label }) => (
        <DropdownMenuItem
          key={deviceId}
          onSelect={() => onChoose(deviceId)}
          // Radix focuses the item under the pointer as well as the keyboard's.
          onFocus={() => setHighlighted(deviceId)}
          onBlur={() => setHighlighted((current) => (current === deviceId ? null : current))}
        >
          <LevelIcon icon={MicIcon} active={active && highlighted === deviceId} />
          {label}
        </DropdownMenuItem>
      ))}
    </>
  )
}

/**
 * The sources, the main microphone first, each with its remove button, which a take's last one
 * lacks the use of. Live transcription lists its one microphone alone, without one. Without a
 * source a placeholder says to add one with the "+". Without the device list the sources stay,
 * and why it is missing shows below them.
 *
 * Each icon lights up while its source picks up sound: from the stream a take or a shared tab,
 * window or screen holds, else, with the microphone permission and outside a take, from one opened
 * for the list while it is shown.
 */
function SourceList({
  kind,
  emptyId,
  listRef,
  onRemoved
}: {
  kind: RecordingKind
  emptyId: string
  listRef: React.Ref<HTMLUListElement>
  /** After the source at this index was removed. */
  onRemoved: (index: number) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { state, sources, liveMicrophone, microphones } = useRecording()
  const problem = useMicrophoneListProblem()
  const live = kind === 'live'
  const list: readonly RecordingSource[] = live
    ? liveMicrophone.current
      ? [{ id: MAIN_SOURCE_ID, kind: 'microphone', ...liveMicrophone.current }]
      : []
    : sources.list
  const fixed = areSourcesLocked(state) || !sources.removable
  // A take opens its microphones itself: no second stream beside them.
  const ownStreams = microphones.granted && !isRecordingBusy(state.status)
  return (
    <>
      {list.length === 0 ? (
        <p id={emptyId} className="m-0 flex min-h-9 items-center">
          {live || sources.displaySupport !== 'supported'
            ? t('transcription.recording.sources.emptyMicrophone')
            : t('transcription.recording.sources.empty')}
        </p>
      ) : (
        <ul
          ref={listRef}
          aria-label={
            live
              ? t('transcription.recording.microphone')
              : t('transcription.recording.sources.listLabel')
          }
          className="m-0 flex list-none flex-col gap-1 p-0"
        >
          {list.map((source, index) => {
            const stream = sources.streams.get(source.id) ?? null
            return (
              <li key={source.id} className="flex min-h-9 items-center gap-stack-sm">
                <ActivityIcon
                  icon={source.kind === 'display' ? MonitorUpIcon : MicIcon}
                  stream={stream}
                  deviceId={!stream && ownStreams ? source.deviceId : null}
                />
                <span className="min-w-0 flex-1 truncate" title={source.label}>
                  {source.label}
                </span>
                {live ? null : (
                  <IconButton
                    label={t('transcription.recording.sources.remove', { name: source.label })}
                    disabled={fixed}
                    onClick={() => {
                      sources.remove(source.id)
                      onRemoved(index)
                    }}
                  >
                    <XIcon {...ICON} />
                  </IconButton>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {problem ? <p className="m-0">{problem}</p> : null}
    </>
  )
}

/**
 * Says what happened to the sources: added and removed ones politely to screen readers, an ended
 * one as a notice until dismissed, and why one could not be added.
 */
export function SourceNotices(): React.JSX.Element {
  const { t } = useTranslation()
  const { sources } = useRecording()
  const { announcement } = sources
  return (
    <>
      <span aria-live="polite" className="sr-only">
        {announcement && announcement.change !== 'ended'
          ? t(`transcription.recording.sources.${announcement.change}`, {
              name: announcement.label
            })
          : ''}
      </span>
      {announcement?.change === 'ended' ? (
        <Notice
          tone="warning"
          inline
          className="basis-full"
          action={
            <IconButton
              label={t('transcription.recording.sources.dismiss')}
              onClick={sources.dismissAnnouncement}
            >
              <XIcon {...ICON} />
            </IconButton>
          }
        >
          {t('transcription.recording.sources.ended', { name: announcement.label })}
        </Notice>
      ) : null}
      {sources.error ? (
        <Notice tone="error" inline className="basis-full">
          {sources.error}
        </Notice>
      ) : null}
    </>
  )
}
