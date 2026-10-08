import { useId, useState } from 'react'
import { CheckIcon, PauseIcon, PlayIcon, Trash2Icon, XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge, Button, Input, Label } from '@ki4jlu/design-system'
import {
  formatWindowTime,
  moveWindowEdge,
  parseTime,
  type SampleDraft,
  type TimeWindow
} from './speakers'
import type { TimePeaks } from './window-peaks'
import { WindowTrack } from './window-track'

const ICON = { 'aria-hidden': true, className: 'size-4' } as const

export interface SampleEditorProps {
  sample: SampleDraft
  voiceName: string
  duration: number | null
  peaks: TimePeaks | null
  /** Whether this sample plays, and where. */
  playing: boolean
  time: number
  onPlay: (start: number, end: number) => void
  onStop: () => void
  /** Moves the playhead of this sample playing, which then stops at `end`. */
  onSeek: (time: number, end: number) => void
  onChange: (change: Partial<SampleDraft>) => void
  onDelete: () => void
}

/**
 * The detail of one sample (kiChat's `snippet-editor-panel`, T-19): play it, drag or type its
 * window, rename it, delete it after a second confirming click.
 */
export function SampleEditor(props: SampleEditorProps): React.JSX.Element {
  const { sample, duration, playing } = props
  const { t } = useTranslation()
  const id = useId()
  const [confirming, setConfirming] = useState(false)
  const name = { sample: sample.label, voice: props.voiceName }

  const setWindow = (window: TimeWindow): void => props.onChange(window)
  // kiChat's editor pauses where the window ends: from before or inside it the sound plays up to
  // there, from after it on.
  const playEnd = (time: number): number => (time < sample.end ? sample.end : Infinity)

  return (
    <section
      aria-label={t('transcription.upload.mapping.sampleEditor', name)}
      className="flex flex-col gap-stack-md"
    >
      <div className="flex min-w-0 items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={
            playing ? t('transcription.common.player.pause') : t('transcription.common.player.play')
          }
          title={t('transcription.common.player.playPause')}
          onClick={() => (playing ? props.onStop() : props.onPlay(sample.start, sample.end))}
        >
          {playing ? <PauseIcon {...ICON} /> : <PlayIcon {...ICON} />}
        </Button>
        <WindowTrack
          window={sample}
          duration={duration}
          peaks={props.peaks}
          playhead={playing ? props.time : null}
          label={t('transcription.upload.mapping.sampleWindow', name)}
          describedBy={`${id}-hint`}
          onChange={setWindow}
          onClick={(time) => (playing ? props.onStop() : props.onPlay(time, playEnd(time)))}
          // A scrub moves the sound playing along; without one it plays from where it was let go,
          // as a click there would.
          onScrub={(time) => {
            if (playing) props.onSeek(time, playEnd(time))
          }}
          onScrubEnd={(time) => {
            if (!playing) props.onPlay(time, playEnd(time))
          }}
        />
      </div>
      <p id={`${id}-hint`} className="sr-only">
        {t('transcription.upload.mapping.sampleWindowHint')}
      </p>
      <div className="grid gap-stack-sm sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-label`}>{t('transcription.upload.mapping.sampleLabel')}</Label>
          <Input
            id={`${id}-label`}
            value={sample.label}
            maxLength={100}
            onChange={(event) => props.onChange({ label: event.target.value })}
          />
        </div>
        <TimeField
          id={`${id}-start`}
          label={t('transcription.upload.mapping.sampleStart')}
          value={sample.start}
          onCommit={(seconds) => setWindow(moveWindowEdge(sample, 'start', seconds, duration))}
        />
        <TimeField
          id={`${id}-end`}
          label={t('transcription.upload.mapping.sampleEnd')}
          value={sample.end}
          onCommit={(seconds) => setWindow(moveWindowEdge(sample, 'end', seconds, duration))}
        />
      </div>
      <div className="flex justify-end gap-1">
        {confirming ? (
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('transcription.upload.mapping.cancelDeleteSample', name)}
              title={t('transcription.common.cancel')}
              onClick={() => setConfirming(false)}
            >
              <XIcon {...ICON} />
            </Button>
            <Button
              type="button"
              variant="ghost-destructive"
              size="icon"
              aria-label={t('transcription.upload.mapping.confirmDeleteSample', name)}
              title={t('transcription.common.confirm')}
              // Focus lands here on the first click, so a second one confirms.
              autoFocus
              onClick={props.onDelete}
            >
              <CheckIcon {...ICON} />
            </Button>
          </>
        ) : (
          <Button
            type="button"
            variant="ghost-destructive"
            size="icon"
            aria-label={`${t('transcription.upload.deleteSnippet')}: ${sample.label}`}
            title={t('transcription.upload.deleteSnippet')}
            onClick={() => setConfirming(true)}
          >
            <Trash2Icon {...ICON} />
          </Button>
        )}
      </div>
    </section>
  )
}

/**
 * A start or end time, typed as seconds or `mm:ss`; set on Enter or when left. Something else is
 * refused, the field shows the time again and says why.
 */
function TimeField({
  id,
  label,
  value,
  onCommit
}: {
  id: string
  label: string
  value: number
  onCommit: (seconds: number) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [text, setText] = useState(() => formatWindowTime(value))
  const [invalid, setInvalid] = useState(false)
  // A drag or the other field moved the window: show its time.
  const [shown, setShown] = useState(value)
  if (shown !== value) {
    setShown(value)
    setText(formatWindowTime(value))
  }

  const commit = (): void => {
    const seconds = parseTime(text)
    if (seconds === null) {
      setInvalid(true)
      setText(formatWindowTime(value))
      return
    }
    setInvalid(false)
    onCommit(seconds)
    setText(formatWindowTime(value))
  }

  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={text}
        inputMode="decimal"
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? `${id}-error` : undefined}
        onChange={(event) => {
          setText(event.target.value)
          setInvalid(false)
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          }
        }}
      />
      {invalid ? (
        <Badge id={`${id}-error`} appearance="text" tone="error">
          {t('transcription.upload.mapping.invalidTime')}
        </Badge>
      ) : null}
    </div>
  )
}
