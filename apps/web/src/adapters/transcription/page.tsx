import { PlusIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button, Card, CardContent, Container } from '@ki4jlu/design-system'
import { ComponentIcon } from '@/components/component-icon'
import { PageHeader } from '@/components/page-header'
import { PageSidePanel } from '@/components/page-side-panel'
import type { ComponentViewProps } from '../types'
import { useTranscriptionCapabilities } from './api'
import { ChoiceView } from './choice'
import { ExportSettings } from './export'
import { HistorySection } from './history'
import { LiveSettings, LiveView } from './live'
import { RecordingProvider, RecordingSettings, RecordView } from './recording'
import { ResultTools, ResultView } from './result'
import { Notice } from './notice'
import { UploadProvider, UploadSettings, UploadView } from './upload'
import { useTranscriptionWorkspace } from './use-workspace'
import { TranscriptionWorkspaceProvider } from './workspace'

/**
 * The transcription module's page, after kiChat's transcription service: the work area shows the
 * entry choice, the upload queue, recording, live transcription or a saved transcript; the
 * settings of that view and the history sit in the shell's column on the right from `lg` up, and
 * in a card below the work area on narrow screens.
 */
export function TranscriptionPage({
  component
}: ComponentViewProps<'transcription'>): React.JSX.Element {
  return (
    <TranscriptionWorkspaceProvider component={component}>
      <UploadProvider>
        <RecordingProvider>
          <TranscriptionLayout />
        </RecordingProvider>
      </UploadProvider>
    </TranscriptionWorkspaceProvider>
  )
}

function TranscriptionLayout(): React.JSX.Element {
  const { t } = useTranslation()
  const { component, capabilities, view, newTranscription } = useTranscriptionWorkspace()
  const capabilitiesQuery = useTranscriptionCapabilities()
  const notSetUp = capabilities && !capabilities.batch && capabilities.realtimeModes.length === 0

  return (
    // `relative`: absolutely placed screen-reader texts stay inside the scrolling area instead of
    // stretching the document.
    <div className="relative min-h-0 flex-1 overflow-y-auto">
      <Container size="page" className="flex flex-col gap-stack-lg py-gutter md:py-margin-page">
        <PageHeader
          title={
            <>
              <ComponentIcon icon={component.icon} iconUrl={component.iconUrl} />
              <span className="truncate">{component.name}</span>
            </>
          }
          actions={
            view === 'choice' ? null : (
              <Button type="button" variant="outline" onClick={() => void newTranscription()}>
                <PlusIcon aria-hidden="true" className="size-4" />
                {t('transcription.common.startNew')}
              </Button>
            )
          }
        />
        {capabilitiesQuery.isError ? (
          <Notice
            tone="error"
            title={t('transcription.common.loadFailed')}
            action={
              <Button
                type="button"
                variant="outline"
                onClick={() => void capabilitiesQuery.refetch()}
              >
                {t('transcription.common.retry')}
              </Button>
            }
          />
        ) : null}
        {notSetUp ? (
          <Notice tone="warning" title={t('transcription.common.notSetUpTitle')}>
            {t('transcription.common.notSetUpDescription')}
          </Notice>
        ) : null}
        <WorkArea />
        <PageSidePanel
          label={t('transcription.common.settings')}
          fallback={
            <Card>
              <CardContent className="flex flex-col gap-stack-lg">
                <SidePanelContent />
              </CardContent>
            </Card>
          }
        >
          <div className="flex flex-col gap-stack-lg">
            <SidePanelContent />
          </div>
        </PageSidePanel>
      </Container>
    </div>
  )
}

/** The view's own area. */
function WorkArea(): React.JSX.Element | null {
  const { view, transcriptId } = useTranscriptionWorkspace()
  switch (view) {
    case 'choice':
      return <ChoiceView />
    case 'upload':
      return <UploadView />
    case 'record':
      return <RecordView />
    case 'live':
      return <LiveView />
    case 'result':
      return transcriptId ? <ResultView key={transcriptId} /> : <ChoiceView />
  }
}

/** The view's settings, then the history. */
function SidePanelContent(): React.JSX.Element {
  return (
    <>
      <ViewSettings />
      <HistorySection />
    </>
  )
}

function ViewSettings(): React.JSX.Element | null {
  const { view, resultTab } = useTranscriptionWorkspace()
  switch (view) {
    case 'upload':
      return <UploadSettings />
    case 'record':
      return <RecordingSettings />
    case 'live':
      return <LiveSettings />
    case 'result':
      return resultTab === 'export' ? <ExportSettings /> : <ResultTools />
    case 'choice':
      return null
  }
}
