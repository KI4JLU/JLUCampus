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
import { areSourcesLocked } from './state'

const ICON = { 'aria-hidden': true, className: 'size-4' } as const

/**
 * The "+" beside the microphone select: another microphone, or a tab, window or screen, before
 * and while recording. The tab picker opens straight from the item's click.
 */
export function AddSourceMenu(): React.JSX.Element {
  const { t } = useTranslation()
  const { state, sources } = useRecording()
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
          label={t('transcription.recording.sources.add')}
          variant="outline"
          disabled={areSourcesLocked(state)}
        >
          <PlusIcon {...ICON} />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {/* DS gap: no DropdownMenuSub; the microphones are a labelled group instead. */}
        <DropdownMenuLabel>{t('transcription.recording.sources.addMicrophone')}</DropdownMenuLabel>
        {sources.addableMicrophones.length === 0 ? (
          <DropdownMenuItem disabled>
            {t('transcription.recording.sources.noMoreMicrophones')}
          </DropdownMenuItem>
        ) : (
          sources.addableMicrophones.map((choice) => (
            <DropdownMenuItem key={choice.deviceId} onSelect={() => sources.addMicrophone(choice)}>
              <MicIcon {...ICON} />
              {choice.label ?? t('transcription.recording.microphoneN', { n: choice.number })}
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={reason !== null} onSelect={sources.addDisplay}>
          <MonitorUpIcon {...ICON} />
          <span className="flex flex-col">
            {t('transcription.recording.sources.addDisplay')}
            {reason ? <span>{reason}</span> : null}
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The added sources, each with its remove button; nothing without any. */
export function SourceList(): React.JSX.Element | null {
  const { t } = useTranslation()
  const { state, sources } = useRecording()
  if (sources.list.length === 0) return null
  const locked = areSourcesLocked(state)
  return (
    <ul
      aria-label={t('transcription.recording.sources.listLabel')}
      className="m-0 flex list-none flex-col gap-1 p-0"
    >
      {sources.list.map((source) => {
        const Icon = source.kind === 'display' ? MonitorUpIcon : MicIcon
        return (
          <li key={source.id} className="flex items-center gap-stack-sm">
            <Icon {...ICON} />
            <span className="min-w-0 flex-1 truncate" title={source.label}>
              {source.label}
            </span>
            <IconButton
              label={t('transcription.recording.sources.remove', { name: source.label })}
              disabled={locked}
              onClick={() => sources.remove(source.id)}
            >
              <XIcon {...ICON} />
            </IconButton>
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
