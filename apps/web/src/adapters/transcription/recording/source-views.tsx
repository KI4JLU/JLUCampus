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
 * The "+" beside the sources. Regular recording adds a microphone not in use, or a tab, window or
 * screen, before and while recording; the tab picker opens straight from the item's click. Live
 * transcription hears one microphone and switches to another instead.
 */
export function AddSourceMenu({ kind }: { kind: RecordingKind }): React.JSX.Element {
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
          label={
            live
              ? t('transcription.recording.sources.switchMicrophone')
              : t('transcription.recording.sources.add')
          }
          variant="outline"
          disabled={problem !== null || areSourcesLocked(state)}
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
        {microphones.length === 0 ? (
          <DropdownMenuItem disabled>
            {t('transcription.recording.sources.noMoreMicrophones')}
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
 * the use of. Live transcription lists its one microphone alone, without one. While the device
 * list is not there, why.
 */
export function SourceList({ kind }: { kind: RecordingKind }): React.JSX.Element {
  const { t } = useTranslation()
  const { state, sources, liveMicrophone } = useRecording()
  const problem = useMicrophoneListProblem()
  if (problem) return <p className="m-0">{problem}</p>
  const live = kind === 'live'
  const list: readonly RecordingSource[] = live
    ? [{ id: MAIN_SOURCE_ID, kind: 'microphone', ...liveMicrophone.current }]
    : sources.list
  const fixed = areSourcesLocked(state) || !sources.removable
  return (
    <ul
      aria-label={
        live
          ? t('transcription.recording.microphone')
          : t('transcription.recording.sources.listLabel')
      }
      className="m-0 flex list-none flex-col gap-1 p-0"
    >
      {list.map((source) => {
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
                onClick={() => sources.remove(source.id)}
              >
                <XIcon {...ICON} />
              </IconButton>
            )}
          </li>
        )
      })}
    </ul>
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
