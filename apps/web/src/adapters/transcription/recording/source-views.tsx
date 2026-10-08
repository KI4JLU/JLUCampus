import { useRef } from 'react'
import { MicIcon, MonitorUpIcon, PlusIcon, XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@ki4jlu/design-system'
import { Notice } from '../notice'
import { IconButton } from '../result/icon-button'
import { useRecording } from './context'
import { MAIN_SOURCE_ID, type RecordingSource } from './sources'
import { areSourcesLocked, type RecordingKind } from './state'

const ICON = { 'aria-hidden': true, className: 'size-4' } as const

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
 * now in its place, else to the "+", so the keyboard does not lose its place.
 */
export function SourceControls({ kind }: { kind: RecordingKind }): React.JSX.Element {
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
        <SourceList kind={kind} listRef={listRef} onRemoved={refocus} />
      </div>
      <AddSourceMenu kind={kind} triggerRef={triggerRef} />
    </div>
  )
}

/**
 * The "+" beside the sources. Regular recording adds a microphone not in use, or a tab, window or
 * screen, before and while recording; the tab picker opens straight from the item's click. Live
 * transcription hears one microphone and switches to another instead; the "+" names the current
 * one, so a switch is heard where the focus returns. Without the device list only the microphones
 * are out of reach.
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
            live
              ? t('transcription.recording.sources.switchMicrophone', {
                  name: liveMicrophone.current.label
                })
              : t('transcription.recording.sources.add')
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
        {problem || microphones.length === 0 ? (
          <DropdownMenuItem disabled>
            {problem ?? t('transcription.recording.sources.noMoreMicrophones')}
          </DropdownMenuItem>
        ) : (
          microphones.map((microphone) => (
            <DropdownMenuItem
              key={microphone.deviceId}
              onSelect={() => choose(microphone.deviceId)}
            >
              <MicIcon {...ICON} />
              {microphone.label}
            </DropdownMenuItem>
          ))
        )}
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
 * The sources, the main microphone first, each with its remove button, which the last one lacks
 * the use of. Live transcription lists its one microphone alone, without one. Without the device
 * list the sources stay, and why it is missing shows below them.
 */
function SourceList({
  kind,
  listRef,
  onRemoved
}: {
  kind: RecordingKind
  listRef: React.Ref<HTMLUListElement>
  /** After the source at this index was removed. */
  onRemoved: (index: number) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { state, sources, liveMicrophone } = useRecording()
  const problem = useMicrophoneListProblem()
  const live = kind === 'live'
  const list: readonly RecordingSource[] = live
    ? [{ id: MAIN_SOURCE_ID, kind: 'microphone', ...liveMicrophone.current }]
    : sources.list
  const fixed = areSourcesLocked(state) || !sources.removable
  return (
    <>
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
          const Icon = source.kind === 'display' ? MonitorUpIcon : MicIcon
          return (
            <li key={source.id} className="flex min-h-9 items-center gap-stack-sm">
              <Icon {...ICON} />
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
