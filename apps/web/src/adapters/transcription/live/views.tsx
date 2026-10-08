import { useEffect, useId, useRef } from 'react'
import { EraserIcon, Maximize2Icon, Minimize2Icon, RotateCcwIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Card,
  CardContent,
  Input,
  Label,
  PanelSection,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '@ki4jlu/design-system'
import { TRANSCRIPTION_LIVE_FONT_SIZE, type TranscriptionRealtimeMode } from '@justcampus/shared'
import { cn } from '@/lib/utils'
import { Notice } from '../notice'
import { BackupFailedNotice } from '../recording/backup-views'
import { useRecording } from '../recording/context'
import { isRecordingBusy } from '../recording/state'
import { RecordingControls, RecordingStatusCard, RecordingTabs, TakeList } from '../recording/views'
import { liveTranscriptRows } from './lines'

const ICON = { 'aria-hidden': true, className: 'size-4' } as const

/**
 * The panel width at which the font size setting is CSS pixels, kiChat's
 * `--live-transcript-canvas-reference`: the text keeps its ratio to the panel, inline or
 * fullscreen.
 */
const CANVAS_REFERENCE_PX = 1280

function useModeLabel(): (mode: TranscriptionRealtimeMode) => string {
  const { t } = useTranslation()
  return (mode) =>
    mode === 'onprem'
      ? t('transcription.recording.modeLocal')
      : t('transcription.recording.modeOpenai')
}

/**
 * The running transcript in the chosen size and contrast (T-60, T-61), as kiChat's rolling
 * subtitle window: the current line in the middle, the two before it above, fading; sample text
 * until the first live session starts. It can fill the screen: in fullscreen where the browser
 * allows it, else over the page; Escape or the button restore it. The size scales with the
 * panel's width, so filling the screen enlarges the text.
 */
function LiveTranscriptPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const { live } = useRecording()
  const { appearance, setAppearance, text, subtitles, started, serviceError } = live
  const panelRef = useRef<HTMLDivElement>(null)
  const rows = started
    ? liveTranscriptRows(subtitles)
    : {
        older: '',
        prev: t('transcription.recording.livePreviewSample'),
        current: t('transcription.recording.livePreviewPlaceholder')
      }
  const maximized = appearance.maximized
  const toggleLabel = maximized
    ? t('transcription.recording.minimizeTextView')
    : t('transcription.recording.maximizeTextView')

  // Fullscreen follows the state.
  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    if (maximized) {
      if (document.fullscreenElement !== panel && typeof panel.requestFullscreen === 'function')
        // Refused (an iframe, iOS): the panel covers the page instead.
        panel.requestFullscreen().catch(() => {})
    } else if (document.fullscreenElement === panel) void document.exitFullscreen().catch(() => {})
  }, [maximized])

  // Leaving fullscreen with the browser's own means restores the panel; so does leaving the view.
  useEffect(() => {
    const panel = panelRef.current
    const onChange = (): void => {
      if (!document.fullscreenElement) setAppearance({ maximized: false })
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      setAppearance({ maximized: false })
      if (panel && document.fullscreenElement === panel)
        void document.exitFullscreen().catch(() => {})
    }
  }, [setAppearance])

  useEffect(() => {
    if (!maximized) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setAppearance({ maximized: false })
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [maximized, setAppearance])

  return (
    <Card
      ref={panelRef}
      className={cn(
        // The font size refers to the card's width (`cqw`).
        '@container flex flex-col overflow-hidden',
        maximized && 'fixed inset-0 z-50',
        // DS gap: no inverted surface for a card; the theme's inverse tokens swap text and ground.
        appearance.inverted && 'bg-inverse-surface text-inverse-on-surface'
      )}
    >
      <CardContent className="flex min-h-0 flex-1 flex-col gap-stack-md pt-6">
        <div className="flex justify-end">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon"
                // A toggle keeps its name; the pressed state says whether it is on.
                aria-pressed={maximized}
                aria-label={t('transcription.recording.maximizeTextView')}
                onClick={() => setAppearance({ maximized: !maximized })}
              >
                {maximized ? <Minimize2Icon {...ICON} /> : <Maximize2Icon {...ICON} />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{toggleLabel}</TooltipContent>
          </Tooltip>
        </div>
        {/* Streaming text is never live: the lines are a picture of the text, which screen readers
            read in full from the region instead. */}
        <section
          aria-label={t('transcription.recording.liveTranscript')}
          className="flex min-h-64 flex-1 flex-col items-center justify-center"
        >
          <p className="sr-only">
            {started ? text : t('transcription.recording.livePreviewPlaceholder')}
          </p>
          {/* DS gap: no caption text at a user-chosen size; the size is the user's setting
              (32–100 px at a 1280 px wide panel), the line width kiChat's 42 characters. */}
          <div
            aria-hidden="true"
            className="mx-auto w-full max-w-[42ch] p-4 text-center break-words"
            style={{
              fontSize: `calc(${appearance.fontSize} / ${CANVAS_REFERENCE_PX} * 100cqw)`,
              lineHeight: 1.5
            }}
          >
            {/* The current line sits in the middle; the ones before it stack upwards. */}
            <div className="relative w-full">
              <div className="absolute inset-x-0 bottom-full mb-[0.4em]">
                <div className="absolute inset-x-0 bottom-full mb-[0.4em] opacity-25">
                  {rows.older}
                </div>
                <div className="opacity-50">{rows.prev}</div>
              </div>
              <div className="font-semibold">{rows.current}</div>
            </div>
          </div>
        </section>
        {serviceError ? (
          <Notice tone="error" inline>
            {serviceError}
          </Notice>
        ) : null}
      </CardContent>
    </Card>
  )
}

/** The work area of the `live` view, with the tab to regular recording (T-59 to T-61). */
export function LiveView(): React.JSX.Element {
  const { t } = useTranslation()
  const { live, state } = useRecording()
  const failed = state.status === 'error' && state.kind === 'live'
  // The local mode is set up but cannot run (the server leaves it out of the modes then).
  const onpremUnavailable = live.config?.onpremUnavailable ?? null
  return (
    <RecordingTabs current="live">
      {onpremUnavailable ? (
        <Notice tone="warning">
          {t(`transcription.recording.onpremUnavailable.${onpremUnavailable.reason}`, {
            model: onpremUnavailable.model
          })}
        </Notice>
      ) : live.modes.length === 0 ? (
        <Notice tone="warning">{t('transcription.recording.liveUnavailable')}</Notice>
      ) : null}
      <BackupFailedNotice />
      {failed || state.status === 'requesting' || state.status === 'stopping' ? (
        <RecordingStatusCard kind="live" />
      ) : null}
      <LiveTranscriptPanel />
      <RecordingControls kind="live" />
      <TakeList />
    </RecordingTabs>
  )
}

/** The side column of the `live` view: the mode and the transcript's appearance (T-59, T-61). */
export function LiveSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const id = useId()
  const { live, state } = useRecording()
  const modeLabel = useModeLabel()
  const busy = isRecordingBusy(state.status)
  const { appearance, setAppearance } = live
  const { min, max } = TRANSCRIPTION_LIVE_FONT_SIZE

  return (
    <>
      <PanelSection
        title={<Label htmlFor={`${id}-mode`}>{t('transcription.recording.modeLabel')}</Label>}
      >
        <Select
          value={live.mode ?? ''}
          disabled={busy || live.modes.length === 0}
          onValueChange={(mode) => live.setMode(mode as TranscriptionRealtimeMode)}
        >
          <SelectTrigger id={`${id}-mode`}>
            <SelectValue placeholder={t('transcription.common.notAvailable')} />
          </SelectTrigger>
          <SelectContent>
            {live.modes.map((mode) => (
              <SelectItem key={mode} value={mode}>
                {modeLabel(mode)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </PanelSection>
      <PanelSection title={t('transcription.recording.appearance')}>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-stack-sm">
            <Label htmlFor={`${id}-size`}>{t('transcription.recording.fontSize')}</Label>
            <output htmlFor={`${id}-size`}>
              {t('transcription.recording.fontSizeValue', { size: appearance.fontSize })}
            </output>
          </div>
          <Input
            id={`${id}-size`}
            type="range"
            min={min}
            max={max}
            step={1}
            value={appearance.fontSize}
            aria-valuetext={t('transcription.recording.fontSizeValue', {
              size: appearance.fontSize
            })}
            onChange={(event) => setAppearance({ fontSize: Number(event.target.value) })}
          />
        </div>
        <div className="flex items-center justify-between gap-stack-sm">
          <Label htmlFor={`${id}-contrast`}>{t('transcription.recording.invertContrast')}</Label>
          <Switch
            id={`${id}-contrast`}
            checked={appearance.inverted}
            onCheckedChange={(inverted) => setAppearance({ inverted })}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={live.resetAppearance}>
            <RotateCcwIcon {...ICON} />
            {t('transcription.recording.resetAppearance')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!live.text}
            onClick={live.clearText}
          >
            <EraserIcon {...ICON} />
            {t('transcription.recording.clearText')}
          </Button>
        </div>
      </PanelSection>
    </>
  )
}
