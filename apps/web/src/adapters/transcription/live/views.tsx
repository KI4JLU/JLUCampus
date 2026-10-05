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
import { useRecording } from '../recording/context'
import { isRecordingBusy } from '../recording/state'
import { RecordingControls, RecordingStatusCard, RecordingTabs, TakeList } from '../recording/views'

const ICON = { 'aria-hidden': true, className: 'size-4' } as const

function useModeLabel(): (mode: TranscriptionRealtimeMode) => string {
  const { t } = useTranslation()
  return (mode) =>
    mode === 'onprem'
      ? t('transcription.recording.modeLocal')
      : t('transcription.recording.modeOpenai')
}

/**
 * The running transcript in the chosen size and contrast (T-60, T-61), with sample text until the
 * first words arrive. It follows the newest text, and can fill the screen: in fullscreen where the
 * browser allows it, else over the page; Escape or the button restore it.
 */
function LiveTranscriptPanel(): React.JSX.Element {
  const { t } = useTranslation()
  const { live } = useRecording()
  const { appearance, setAppearance, text, serviceError } = live
  const panelRef = useRef<HTMLDivElement>(null)
  const logRef = useRef<HTMLDivElement>(null)
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

  // The newest words stay in view.
  useEffect(() => {
    const log = logRef.current
    if (log) log.scrollTop = log.scrollHeight
  }, [text])

  return (
    <Card
      ref={panelRef}
      className={cn(
        'flex flex-col',
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
        {/* DS gap: no caption text at a user-chosen size; the size is the user's setting (32–100 px). */}
        <div
          ref={logRef}
          role="log"
          aria-label={t('transcription.recording.liveTranscript')}
          className={cn(
            'flex min-h-64 flex-1 flex-col overflow-y-auto',
            text ? 'justify-start' : 'items-center justify-center text-center'
          )}
          style={{ fontSize: `${appearance.fontSize}px`, lineHeight: 1.3 }}
        >
          {text ? (
            <p className="m-0 whitespace-pre-wrap">{text}</p>
          ) : (
            <>
              <p aria-hidden="true" className="m-0 opacity-60">
                {t('transcription.recording.livePreviewSample')}
              </p>
              <p className="m-0 font-semibold">
                {t('transcription.recording.livePreviewPlaceholder')}
              </p>
            </>
          )}
        </div>
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
