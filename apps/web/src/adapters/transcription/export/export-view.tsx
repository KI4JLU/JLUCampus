import { useId, useMemo, useState } from 'react'
import { ChevronRightIcon, DownloadIcon, FileTextIcon, RefreshCwIcon } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  CodeBlock,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '@ki4jlu/design-system'
import type { TranscriptionTemplate } from '@justcampus/shared'
import { meQuery } from '@/lib/queries'
import { toast } from '@/lib/toast'
import { transcriptQuery, useTranscriptionCapabilities, useTranscriptionTemplates } from '../api'
import { Notice } from '../notice'
import { SummaryPanel } from '../summary'
import { summarySource } from '../summary/source'
import { useSummary, type SummaryState } from '../summary/use-summary'
import { TemplateEditor, TemplateLibraryDialog } from '../templates'
import {
  activeTemplate,
  templateActions,
  templateScope,
  useTemplateState
} from '../templates/store'
import { templateSubtext } from '../templates/structure'
import { useTranscriptionWorkspace } from '../use-workspace'
import type { TranscriptDocument } from '../workspace'
import { documentDocx, documentPdf, markdownPlainText } from './documents'
import {
  downloadBlob,
  exportFilename,
  FORMAT_LABELS,
  FORMAT_TYPES,
  formatsOf,
  type DocumentFormat,
  type ExportFormat,
  type SubtitleFormat
} from './files'
import { formatTranscript, protocolText, segmentsJson, transcriptPlainText } from './format'
import { ActiveFormatName } from './export-settings'
import { focusTranscriptFormatting } from './formatting-focus'
import { useSpeakerLabels } from './hooks'
import { CopyAction } from './parts'
import { subtitleCues, toSrt, toVtt } from './subtitles'
import { exportActions, useExportState, type ExportState } from './store'
import { TranscriptPreview } from './transcript-preview'

const ICON = { 'aria-hidden': true, className: 'size-4' } as const

/**
 * The Export tab's work area (T-41 to T-49): the preview of what is chosen in the side column,
 * with its template or format, and the footer that downloads or copies it. The template editor
 * takes the area's place while it is open.
 */
export function ExportView(): React.JSX.Element {
  const { t } = useTranslation()
  const { currentDocument, component } = useTranscriptionWorkspace()
  const me = useQuery(meQuery).data
  const { draft, session, libraryOpen, selectedId } = useTemplateState(
    templateScope(me?.id, component.id)
  )
  const templates = useTranscriptionTemplates()

  const active = activeTemplate(
    templates.data,
    selectedId,
    currentDocument?.transcript.summaryTemplateId ?? null
  )

  return (
    <>
      {draft ? (
        <TemplateEditor key={session} draft={draft} />
      ) : currentDocument ? (
        <ExportPreview document={currentDocument} templates={templates} template={active} />
      ) : (
        <p className="m-0">{t('transcription.export.noTranscriptLoaded')}</p>
      )}
      <TemplateLibraryDialog
        open={libraryOpen}
        onOpenChange={templateActions.setLibraryOpen}
        activeId={active?.id ?? null}
        onChoose={(id) => {
          templateActions.select(id)
          templateActions.setLibraryOpen(false)
        }}
      />
    </>
  )
}

/** The format the footer downloads in the current category. */
function currentFormat(state: ExportState): ExportFormat {
  switch (state.category) {
    case 'summary':
    case 'transcript':
      return state.documentFormat
    case 'subtitles':
      return state.subtitleFormat
    case 'json':
      return 'json'
  }
}

function ExportPreview({
  document,
  templates,
  template
}: {
  document: TranscriptDocument
  templates: ReturnType<typeof useTranscriptionTemplates>
  template: TranscriptionTemplate | null
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const state = useExportState()
  const labels = useSpeakerLabels()
  const { transcript, segments, speakerColors } = document
  const { category, flags } = state
  const format = currentFormat(state)
  const visibleOfTranscript = state.visibleSpeakers[transcript.id]
  const visible = useMemo(() => visibleOfTranscript ?? {}, [visibleOfTranscript])

  // The summary model is part of the summary's identity; it is known once the module answered.
  const capabilities = useTranscriptionCapabilities()
  // A local transcript sends its current text, redactions applied (T-49).
  const source = useMemo(() => summarySource(document), [document])
  // The server fills `{{title}}` with its copy's title, which a generated title replaces without a
  // new revision; the result view keeps that copy in the cache and fetches it again on request.
  const serverTitle = useQuery({
    ...transcriptQuery(transcript.id),
    enabled: false,
    select: (saved) => saved.title
  }).data
  const summary = useSummary(
    template && !capabilities.isPending
      ? {
          transcriptId: transcript.id,
          revision: transcript.revision,
          title: serverTitle ?? transcript.title,
          text: source.transcriptText,
          templateId: template.id,
          templateVersion: template.version,
          model: capabilities.data?.defaultSummaryModel ?? null
        }
      : null,
    category === 'summary'
  )

  const formatted = useMemo(
    () => formatTranscript(segments, flags, visible, speakerColors, labels),
    [segments, flags, visible, speakerColors, labels]
  )
  const subtitles = useMemo(
    () => (category === 'subtitles' ? subtitleCues(segments, labels, flags.anonymize) : []),
    [category, segments, labels, flags.anonymize]
  )
  const subtitleText = state.subtitleFormat === 'vtt' ? toVtt(subtitles) : toSrt(subtitles)
  const json = useMemo(
    () => (category === 'json' ? segmentsJson(segments) : ''),
    [category, segments]
  )

  const allHidden = t('transcription.export.allSpeakersHidden')
  /** The running record, stamped with the time it is made. */
  const protocol = (): string =>
    protocolText(formatted, flags, {
      header: t('transcription.export.protocolHeader'),
      createdAt: t('transcription.export.createdAt', {
        timestamp: new Date().toLocaleString(i18n.language)
      }),
      transcriptId: t('transcription.export.transcriptId', { id: transcript.id }),
      participants: t('transcription.export.participantsHeader'),
      allHidden
    })

  const markdown = summary.summary?.markdown ?? ''
  const noSegments = segments.length === 0 && category !== 'summary'
  const ready =
    category === 'summary' ? summary.status === 'ready' && markdown.length > 0 : !noSegments

  /** What the copy button takes: Markdown as source, everything else as the preview reads. */
  const copyText = (): string => {
    switch (category) {
      case 'summary':
        return format === 'markdown' ? markdown : markdownPlainText(markdown)
      case 'transcript':
        return format === 'markdown' ? protocol() : transcriptPlainText(formatted, flags, allHidden)
      case 'subtitles':
        return subtitleText
      case 'json':
        return json
    }
  }

  const [busy, setBusy] = useState(false)
  const download = async (): Promise<void> => {
    const filename = exportFilename(transcript.id, format)
    const isMarkdown = category === 'summary'
    const content = category === 'summary' ? markdown : category === 'transcript' ? protocol() : ''
    if (format === 'docx' || format === 'pdf') {
      setBusy(true)
      try {
        const blob =
          format === 'docx'
            ? await documentDocx(content, transcript.title, isMarkdown)
            : await documentPdf(content, transcript.title, isMarkdown)
        downloadBlob(blob, filename)
      } catch {
        toast({
          variant: 'error',
          title:
            format === 'docx'
              ? t('transcription.export.docxFailed')
              : t('transcription.export.pdfFailed')
        })
      } finally {
        setBusy(false)
      }
      return
    }
    const text =
      format === 'markdown'
        ? content
        : format === 'txt'
          ? copyText()
          : category === 'subtitles'
            ? subtitleText
            : json
    downloadBlob(new Blob([text], { type: FORMAT_TYPES[format] }), filename)
  }

  const status =
    category !== 'summary'
      ? t('transcription.export.previewReady')
      : summary.status === 'loading'
        ? t('transcription.export.generatingReport')
        : summary.status === 'error'
          ? t('transcription.export.generationFailed')
          : summary.status === 'ready'
            ? t('transcription.export.summaryReady')
            : t('transcription.export.summaryNotCreated')

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-stack-md">
        <CardTitle asChild>
          <h2>{t('transcription.common.preview')}</h2>
        </CardTitle>
        {category === 'summary' && summary.status === 'ready' ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t('transcription.export.regenerateView')}
                onClick={() => summary.generate(true)}
              >
                <RefreshCwIcon {...ICON} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('transcription.export.regenerateView')}</TooltipContent>
          </Tooltip>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-stack-lg">
        {category === 'summary' ? (
          <SummaryBody templates={templates} template={template} summary={summary} />
        ) : noSegments ? (
          <p className="m-0">{t('transcription.export.noSegments')}</p>
        ) : category === 'transcript' ? (
          <>
            <ChoiceRow
              label={t('transcription.export.formatting')}
              current={<ActiveFormatName />}
              onChange={focusTranscriptFormatting}
            />
            <TranscriptPreview formatted={formatted} flags={flags} />
          </>
        ) : (
          // DS gap: CodeBlock has no height cap; long files scroll in the wrapper.
          <div className="max-h-128 overflow-y-auto">
            <CodeBlock
              code={category === 'subtitles' ? subtitleText : json}
              copyLabel={t('transcription.common.copy')}
              copiedLabel={t('transcription.export.copied')}
            />
          </div>
        )}
      </CardContent>
      <CardFooter className="flex flex-col items-stretch gap-stack-md">
        <ExportFooter
          status={status}
          format={format}
          ready={ready}
          busy={busy}
          onDownload={() => void download()}
          copyText={copyText}
        />
      </CardFooter>
    </Card>
  )
}

/** The summary's template line and the summary itself (T-48, T-50). */
function SummaryBody({
  templates,
  template,
  summary
}: {
  templates: ReturnType<typeof useTranscriptionTemplates>
  template: TranscriptionTemplate | null
  summary: SummaryState
}): React.JSX.Element {
  const { t } = useTranslation()
  if (templates.isError) {
    return (
      <Notice
        tone="error"
        action={
          <Button type="button" variant="outline" onClick={() => void templates.refetch()}>
            {t('transcription.common.retry')}
          </Button>
        }
      >
        {t('transcription.export.templatesLoadFailed')}
      </Notice>
    )
  }
  if (!template) return <Spinner label={t('transcription.common.loading')} />
  return (
    <>
      <ChoiceRow
        label={t('transcription.export.template')}
        current={
          <span className="flex min-w-0 items-center gap-stack-sm">
            <FileTextIcon {...ICON} />
            <span className="truncate">{template.name}</span>
          </span>
        }
        onChange={templateActions.openLibrary}
      />
      <SummaryPanel
        state={summary}
        templateName={template.name}
        subtext={templateSubtext(template.structure)}
      />
    </>
  )
}

/**
 * kiChat's subheader row: a visible label ("Vorlage", "Formatierung") above the template or format
 * in use, with "Ändern".
 */
function ChoiceRow({
  label,
  current,
  onChange
}: {
  label: string
  current: React.ReactNode
  onChange: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const id = useId()
  return (
    <div role="group" aria-labelledby={id} className="flex flex-col gap-1">
      {/* DS gap: no caption for a read-only value; `Label` gives it the label's look. */}
      <Label id={id}>{label}</Label>
      <div className="flex flex-wrap items-center justify-between gap-stack-sm">
        {current}
        <Button type="button" variant="outline" size="sm" onClick={onChange}>
          {t('transcription.export.change')}
          <ChevronRightIcon {...ICON} />
        </Button>
      </div>
    </div>
  )
}

/**
 * "Herunterladen als": the status, the format, the download and copying. Everything waits while a
 * summary is missing or being written (T-41, T-48).
 */
function ExportFooter({
  status,
  format,
  ready,
  busy,
  onDownload,
  copyText
}: {
  status: string
  format: ExportFormat
  ready: boolean
  busy: boolean
  onDownload: () => void
  copyText: () => string
}): React.JSX.Element {
  const { t } = useTranslation()
  const { category } = useExportState()
  const id = useId()
  const formats = formatsOf(category)
  // kiChat names the format by its id in capitals ("Als MARKDOWN herunterladen").
  const downloadLabel = t('transcription.export.downloadAsFormat', {
    format: format.toUpperCase()
  })

  const changeFormat = (value: string): void => {
    if (category === 'subtitles') exportActions.setSubtitleFormat(value as SubtitleFormat)
    else exportActions.setDocumentFormat(value as DocumentFormat)
  }

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-stack-sm">
        <Label htmlFor={formats.length > 1 ? id : undefined}>
          {t('transcription.export.downloadAs')}
        </Label>
        <p role="status" className="m-0">
          {status}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-stack-sm">
        {formats.length > 1 ? (
          <Select value={format} onValueChange={changeFormat} disabled={!ready}>
            <SelectTrigger id={id} className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {formats.map((option) => (
                <SelectItem key={option} value={option}>
                  {FORMAT_LABELS[option]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <Button type="button" disabled={!ready || busy} onClick={onDownload} className="flex-1">
          {busy ? <Spinner size="sm" label={downloadLabel} /> : <DownloadIcon {...ICON} />}
          {downloadLabel}
        </Button>
        <CopyAction text={copyText} disabled={!ready} />
      </div>
    </>
  )
}
