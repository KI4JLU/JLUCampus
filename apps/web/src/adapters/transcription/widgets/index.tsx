import { useMemo } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { FileUpIcon, MicIcon, PlusIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Badge,
  Button,
  Spinner,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  type BadgeProps
} from '@ki4jlu/design-system'
import {
  isActiveJobStatus,
  TRANSCRIPTION_ANALYSIS_STATUSES,
  TRANSCRIPTION_PROCESSING_STATUSES,
  type TranscriptionJob,
  type TranscriptionJobStatus
} from '@justcampus/shared'
import { ComponentIcon } from '@/components/component-icon'
import { useComponentName } from '@/lib/component-name'
import type { ComponentOf, ComponentViewProps } from '../../types'
import { useTranscriptionCapabilities, useTranscriptionJobs, useTranscripts } from '../api'
import { setTranscriptionTarget, type TranscriptionTarget } from './target-store'

/**
 * Dashboard widgets (see `COMPONENT_WIDGETS.transcription`): `quick` starts a transcription and
 * counts the running jobs, `recent` lists the jobs in progress and the newest saved transcripts.
 * Both open the module's page at the chosen view or transcript.
 */

const ICON = { 'aria-hidden': true, className: 'size-4' } as const

/** Entries the recent widget lists of each kind. */
const RECENT_JOBS = 3
const RECENT_TRANSCRIPTS = 8

/** The user's unsaved jobs, kept current by the event stream. */
function useWidgetJobs(enabled: boolean): {
  jobs: TranscriptionJob[]
  active: number
} {
  const query = useTranscriptionJobs(enabled)
  return useMemo(() => {
    const jobs = query.data ?? []
    return { jobs, active: jobs.filter((job) => isActiveJobStatus(job.status)).length }
  }, [query.data])
}

/** Opens the page with what the widget asks for. */
function useOpenPage(
  component: ComponentOf<'transcription'>
): (target: TranscriptionTarget) => void {
  const navigate = useNavigate()
  return (target) => {
    setTranscriptionTarget(component.id, target)
    void navigate({ to: '/c/$componentId', params: { componentId: component.id } })
  }
}

function TileHeader({ component }: ComponentViewProps<'transcription'>): React.JSX.Element {
  const { t } = useTranslation()
  const name = useComponentName()(component)
  return (
    // DS gap: no compact header for a dashboard tile; the same bar as the translator's and the feeds'.
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-outline-variant px-3">
      <span className="flex shrink-0 text-on-surface-variant">
        <ComponentIcon icon={component.icon} iconUrl={component.iconUrl} />
      </span>
      <h2 className="m-0 flex min-w-0 flex-1 text-sm font-semibold text-on-surface">
        <Link
          to="/c/$componentId"
          params={{ componentId: component.id }}
          aria-label={t('dashboard.openPage', { name })}
          className="truncate text-on-surface no-underline hover:underline"
        >
          {name}
        </Link>
      </h2>
    </div>
  )
}

/** A new transcription: the entry choice, or straight to upload or recording; the running jobs. */
export function QuickTile({ component }: ComponentViewProps<'transcription'>): React.JSX.Element {
  const { t } = useTranslation()
  const capabilities = useTranscriptionCapabilities().data
  const batch = capabilities?.batch ?? false
  const live = (capabilities?.realtimeModes.length ?? 0) > 0
  const { active } = useWidgetJobs(batch)
  const open = useOpenPage(component)
  const shortcuts = [
    {
      key: 'upload',
      label: t('transcription.recording.widgets.upload'),
      icon: <FileUpIcon {...ICON} />,
      available: batch,
      target: { view: 'upload' } as const
    },
    {
      key: 'record',
      label: t('transcription.recording.widgets.record'),
      icon: <MicIcon {...ICON} />,
      available: batch || live,
      target: { view: batch ? 'record' : 'live' } as const
    }
  ]

  return (
    <div className="flex size-full flex-col">
      <TileHeader component={component} />
      <div className="flex min-h-0 flex-1 flex-wrap content-start items-center gap-2 overflow-hidden p-3">
        <Button type="button" size="sm" onClick={() => open({ view: 'choice' })}>
          <PlusIcon {...ICON} />
          {t('transcription.common.newTranscription')}
        </Button>
        {shortcuts.map((shortcut) => (
          <Tooltip key={shortcut.key}>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon"
                aria-label={shortcut.label}
                disabled={!shortcut.available}
                onClick={() => open(shortcut.target)}
              >
                {shortcut.icon}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{shortcut.label}</TooltipContent>
          </Tooltip>
        ))}
        {active > 0 ? (
          <Button type="button" variant="link" size="sm" onClick={() => open({ view: 'upload' })}>
            {t('transcription.recording.widgets.activeJobs', { count: active })}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

type JobStatusGroup =
  'uploading' | 'analyzing' | 'analyzed' | 'processing' | 'completed' | 'failed' | 'cancelled'

function statusGroup(status: TranscriptionJobStatus): JobStatusGroup {
  if ((TRANSCRIPTION_ANALYSIS_STATUSES as readonly string[]).includes(status)) return 'analyzing'
  if ((TRANSCRIPTION_PROCESSING_STATUSES as readonly string[]).includes(status)) return 'processing'
  return status as Exclude<JobStatusGroup, 'analyzing' | 'processing'>
}

const STATUS_TONES: Record<JobStatusGroup, NonNullable<BadgeProps['tone']>> = {
  uploading: 'info',
  analyzing: 'info',
  analyzed: 'warning',
  processing: 'info',
  completed: 'warning',
  failed: 'error',
  cancelled: 'neutral'
}

/** The jobs in progress and the newest saved transcripts. */
export function RecentTile({ component }: ComponentViewProps<'transcription'>): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const batch = useTranscriptionCapabilities().data?.batch ?? false
  const { jobs } = useWidgetJobs(batch)
  const transcripts = useTranscripts()
  const open = useOpenPage(component)
  const dates = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }),
    [i18n.language]
  )
  const recentJobs = jobs.filter((job) => job.transcriptId === null).slice(0, RECENT_JOBS)
  const recent = (transcripts.data ?? []).slice(0, RECENT_TRANSCRIPTS)

  return (
    <div className="flex size-full flex-col">
      <TileHeader component={component} />
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {recentJobs.length > 0 ? (
          <section aria-label={t('transcription.recording.widgets.jobsTitle')}>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {recentJobs.map((job) => {
                const group = statusGroup(job.status)
                return (
                  <li key={job.id}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="w-full justify-between gap-2"
                      onClick={() => open({ view: 'upload' })}
                    >
                      <span className="min-w-0 truncate">{job.filename}</span>
                      <Badge tone={STATUS_TONES[group]}>
                        {t(`transcription.recording.widgets.jobStatus.${group}`)}
                      </Badge>
                    </Button>
                  </li>
                )
              })}
            </ul>
          </section>
        ) : null}
        <section aria-label={t('transcription.recording.widgets.transcriptsTitle')}>
          {transcripts.isPending ? (
            <Spinner label={t('transcription.common.loading')} />
          ) : transcripts.isError ? (
            <p className="m-0">{t('transcription.common.loadFailed')}</p>
          ) : recent.length === 0 ? (
            <p className="m-0">{t('transcription.recording.widgets.recentEmpty')}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {recent.map((transcript) => (
                <li key={transcript.id}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-auto w-full flex-col items-start gap-0"
                    onClick={() => open({ transcriptId: transcript.id })}
                  >
                    <span className="w-full min-w-0 truncate text-left">{transcript.title}</span>
                    <span className="w-full min-w-0 truncate text-left">
                      {dates.format(new Date(transcript.updatedAt))}
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
