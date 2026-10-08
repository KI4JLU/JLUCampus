import type { DragEvent } from 'react'
import type { ReactNode } from 'react'
import { GripVerticalIcon, RotateCcwIcon, UsersIcon, XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge, Button } from '@ki4jlu/design-system'
import { useJobAudioUrl } from '../api'
import { WaveformPlayer } from '../audio'
import { unidentifiedVoiceCount } from '../mapping/speakers'
import { useTranscriptionWorkspace } from '../use-workspace'
import { serverWaveform, type FilePosition, type QueueFile } from './queue'
import { errorText, percentText, statusText, TONE } from './texts'
import { useUpload } from './use-upload'

const ICON = { 'aria-hidden': true, className: 'size-4' } as const

export interface FileRowProps {
  file: QueueFile
  position: FilePosition
  /** The group is saved as a transcript: no removing, retrying or naming voices. */
  saved: boolean
  /**
   * No moving: a start runs or the group is saved or being saved (T-07, T-11). Removing stays
   * possible until the group is saved, during a start too (kiChat cancels the job then).
   */
  locked: boolean
  /** The group's transcript is being saved: no removing, as the transcript needs the audio. */
  saving: boolean
  processing: boolean
  onOpenMapping: (fileId: string) => void
  onDragStart: (position: FilePosition) => void
  onDragEnd: () => void
  /** Something was dropped on this row: a file of the queue or files from outside (T-07). */
  onDrop: (position: FilePosition, event: DragEvent<HTMLElement>) => void
  onDragOver: (position: FilePosition, event: DragEvent<HTMLElement>) => void
}

/**
 * One file of the queue (kiChat's `multi-upload-item`): a handle to drag it (T-07), its player with
 * name, size and length (T-12), the voices to name (T-17), removal (T-08), and its progress and
 * status (T-11), with the reason when it failed (T-16) or what it did without (one automatic voice,
 * no AI correction). The handle takes its own column over the row's full height, so the row reads
 * as indented by it and can be grabbed beside any of its lines. As kiChat's it is compact otherwise:
 * the actions sit on the player's line, and percentage, status and notice share one line below it,
 * with a progress bar beside the percentage while the file processes.
 */
export function FileRow(props: FileRowProps): React.JSX.Element {
  const { file, position, saved, locked, saving, processing } = props
  const { t, i18n } = useTranslation()
  const { queue, dialogs, start } = useUpload()
  const { capabilities } = useTranscriptionWorkspace()
  const unnamed = unidentifiedVoiceCount(file.voices)
  const canMap =
    capabilities?.diarization !== false && file.voices !== null && !file.result && !saved
  const canRetry =
    !saved &&
    ((file.phase === 'analysisFailed' && (file.uploaded || file.file !== null)) ||
      file.phase === 'failed')
  const status = statusText(t, file.status)
  const waveform = serverWaveform(file)
  // The bar shows that the file is being worked on; the badge beside it names the percentage.
  const progress = file.tone === 'processing' ? Math.min(Math.max(file.progress, 0), 100) : null

  const remove = async (): Promise<void> => {
    if (queue.removalDeletesJob(file.id)) {
      const confirmed = await dialogs.confirm({
        title: t('transcription.upload.deleteJobTitle'),
        message: t('transcription.upload.confirmDeleteJob', { name: file.name }),
        confirmLabel: t('transcription.common.confirm')
      })
      if (!confirmed) return
    }
    if (!(await queue.removeFile(file.id))) {
      await dialogs.alert({
        title: t('transcription.common.error'),
        message: t('transcription.upload.deleteJobFailed')
      })
    }
  }

  const retry = (): void => {
    // A failed transcription is tried again by the start, which keeps the results that worked.
    if (file.phase === 'failed') void start()
    else void queue.retry(file.id)
  }

  // A locked row keeps the handle's column empty, so its lines line up with the movable rows of
  // other groups.
  const handle = locked ? (
    <span aria-hidden="true" className="w-4 shrink-0" />
  ) : (
    // The pointer's handle, centred in its column; the whole column can be grabbed.
    <span
      draggable
      aria-hidden="true"
      title={t('transcription.upload.moveFile')}
      className="flex w-4 shrink-0 cursor-grab touch-none items-center self-stretch"
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', file.id)
        props.onDragStart(position)
      }}
      onDragEnd={props.onDragEnd}
    >
      <GripVerticalIcon {...ICON} />
    </span>
  )

  // A saved group's file has none: no naming voices, retrying or removing.
  const actions = saved ? null : (
    <div className="flex shrink-0 items-center gap-1">
      {canMap ? (
        <Button
          type="button"
          variant={file.voicesSaved ? 'secondary' : 'outline'}
          size="sm"
          // While a start runs, files not dispatched yet can still be named (kiChat reads the
          // names only when it dispatches a file); a failed one is dispatched again.
          disabled={file.phase === 'transcribing' || file.phase === 'completed'}
          aria-label={[
            t('transcription.upload.adjustSpeakersNamed', { name: file.name }),
            unnamed > 0 ? t('transcription.upload.unidentifiedSpeakers', { count: unnamed }) : null,
            file.voicesSaved ? t('transcription.upload.speakersSavedHint') : null
          ]
            .filter(Boolean)
            .join(', ')}
          title={t('transcription.upload.adjustSpeakers')}
          onClick={() => props.onOpenMapping(file.id)}
        >
          <UsersIcon {...ICON} />
          {unnamed > 0 ? <Badge tone="primary">{unnamed}</Badge> : null}
        </Button>
      ) : null}
      {canRetry ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={processing}
          aria-label={t('transcription.upload.retryNamed', { name: file.name })}
          title={t('transcription.common.retry')}
          onClick={retry}
        >
          <RotateCcwIcon {...ICON} />
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={saving}
        aria-label={t('transcription.upload.removeFileNamed', { name: file.name })}
        title={t('transcription.upload.removeFile')}
        onClick={() => void remove()}
      >
        <XIcon {...ICON} />
      </Button>
    </div>
  )

  return (
    // Padded off the dividers between the rows of its group.
    <li
      className="flex min-w-0 gap-3 py-3 first:pt-0 last:pb-0"
      onDragOver={(event) => props.onDragOver(position, event)}
      onDrop={(event) => props.onDrop(position, event)}
    >
      {handle}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {file.file ? (
          <WaveformPlayer
            source={file.file}
            name={file.name}
            knownDuration={file.duration ?? undefined}
            jobId={waveform?.jobId ?? null}
            jobRevision={waveform?.revision}
            trailing={actions}
            className="gap-1"
            onDuration={(seconds) => queue.setDuration(file.id, seconds)}
          />
        ) : (
          <RestoredPlayer file={file} trailing={actions} />
        )}
        {/*
         * Percentage, progress bar, status and what the file did without or why it failed share one
         * line, wrapping where it is too narrow. The bar carries the progressbar role; the status
         * beside it is announced as it changes.
         */}
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <Badge appearance="filled" tone={TONE[file.tone]}>
            {percentText(i18n.language, file.progress)}
          </Badge>
          {progress !== null ? (
            // DS gap: no Progress; a track in the waveform's unplayed colour, filled in the primary.
            <div
              role="progressbar"
              aria-label={t('transcription.upload.progressOf', { name: file.name })}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(progress)}
              className="h-1.5 w-32 overflow-hidden rounded-full bg-outline-variant"
            >
              <div
                className="h-full bg-primary transition-[width] motion-reduce:transition-none"
                style={{ width: `${progress}%` }}
              />
            </div>
          ) : null}
          <span aria-live="polite" className="min-w-0">
            <Badge appearance="text" tone={TONE[file.tone]}>
              {status}
            </Badge>
          </span>
          {file.error ? (
            <Badge appearance="text" tone="error">
              {errorText(t, file.error)}
            </Badge>
          ) : null}
          {file.notice && !file.error ? (
            <Badge appearance="text" tone="warning">
              {t(`transcription.upload.notice.${file.notice}`)}
            </Badge>
          ) : null}
        </div>
      </div>
    </li>
  )
}

/** A restored job has no local file: it plays from storage (T-15). */
function RestoredPlayer({
  file,
  trailing
}: {
  file: QueueFile
  trailing: ReactNode
}): React.JSX.Element {
  const audio = useJobAudioUrl(file.uploaded ? file.jobId : null)
  const waveform = serverWaveform(file)
  return (
    <WaveformPlayer
      source={audio.data?.url ?? null}
      name={file.name}
      size={file.size}
      knownDuration={file.duration ?? undefined}
      jobId={waveform?.jobId ?? null}
      jobRevision={waveform?.revision}
      trailing={trailing}
      className="gap-1"
    />
  )
}
