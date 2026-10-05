import { lazy, Suspense } from 'react'
import { SparklesIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge, Button, PanelSection, Spinner } from '@ki4jlu/design-system'
import { cn } from '@/lib/utils'
import { Notice } from '../notice'
import { skeletonHeadlines, summaryErrorMessage, type SummaryState } from './use-summary'

const MarkdownView = lazy(() => import('./markdown-view'))

const ICON = { 'aria-hidden': true, className: 'size-4' } as const

export interface SummaryPanelProps {
  state: SummaryState
  /** The template's name, for "Wird nach deiner Vorlage … erstellt". */
  templateName: string
  /** Its AI sections' headings, ` · ` between them; empty for a single unnamed section. */
  subtext: string
}

/**
 * The summary in the export preview (T-48): the empty state with the template's sections and the
 * generate action, section skeletons while it is written, the Markdown once it is there, or the
 * error with a retry.
 */
export function SummaryPanel({
  state,
  templateName,
  subtext
}: SummaryPanelProps): React.JSX.Element {
  const { t } = useTranslation()
  const headlines = skeletonHeadlines(subtext, t('transcription.export.summarySkeleton'))

  switch (state.status) {
    case 'idle':
    case 'checking':
      return (
        <div className="flex items-center gap-stack-sm py-gutter">
          <Spinner label={t('transcription.export.checkingData')} />
          <span>{t('transcription.export.checkingData')}</span>
        </div>
      )
    case 'empty':
      return (
        <div className="flex flex-col gap-stack-lg">
          <PanelSection
            title={t('transcription.export.generateSummaryTitle')}
            hint={t('transcription.export.templateHint', { template: templateName })}
          >
            <p className="m-0">{t('transcription.export.generateSummaryDesc')}</p>
          </PanelSection>
          <PanelSection title={t('transcription.export.whatWillBeCreated')}>
            <Skeleton headlines={headlines} active={false} />
          </PanelSection>
          <div>
            <Button type="button" onClick={() => state.generate(false)}>
              <SparklesIcon {...ICON} />
              {t('transcription.export.createSummary')}
            </Button>
          </div>
        </div>
      )
    case 'loading':
      return (
        <div role="status" className="flex flex-col gap-stack-lg">
          <PanelSection
            title={t('transcription.export.generatingSummary')}
            hint={t('transcription.export.generatingSummaryHint')}
          >
            <Skeleton headlines={headlines} active />
          </PanelSection>
        </div>
      )
    case 'error':
      return (
        <Notice
          tone="error"
          title={t('transcription.export.generationFailed')}
          action={
            <Button type="button" variant="outline" onClick={() => state.generate(false)}>
              {t('transcription.common.retry')}
            </Button>
          }
        >
          {summaryErrorMessage(state.error, {
            prefix: t('transcription.export.generationFailedPrefix'),
            serverError: t('transcription.export.serverError'),
            communicationError: t('transcription.export.communicationError')
          })}
        </Notice>
      )
    case 'ready':
      return (
        <Suspense fallback={<Spinner label={t('transcription.common.loading')} />}>
          <MarkdownView
            markdown={state.summary?.markdown ?? ''}
            label={t('transcription.export.summary')}
          />
        </Suspense>
      )
  }
}

/** kiChat's widths of a section's lines: full, half, two thirds, in turn. */
const WIDTHS = ['w-full', 'w-1/2', 'w-2/3'] as const

/**
 * One labelled group of placeholder lines per section; pulsing while the summary is written.
 * DS gap: there is no Skeleton; the bars use the surface tokens.
 */
function Skeleton({
  headlines,
  active
}: {
  headlines: string[]
  active: boolean
}): React.JSX.Element {
  const bar = cn('h-3 rounded-full bg-surface-container-high', active && 'animate-pulse')
  return (
    <ul className="m-0 flex list-none flex-col gap-stack-md p-0">
      {headlines.map((headline, index) => (
        <li key={`${index}-${headline}`} className="flex flex-col gap-stack-sm">
          <Badge tone="neutral" appearance="text">
            {headline}
          </Badge>
          <div aria-hidden="true" className={cn(bar, WIDTHS[index % 3])} />
          {index % 2 === 0 ? (
            <div aria-hidden="true" className={cn(bar, index % 3 === 0 ? 'w-2/3' : 'w-1/2')} />
          ) : null}
        </li>
      ))}
    </ul>
  )
}
