import type { DragEvent } from 'react'
import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  FolderInputIcon,
  GripVerticalIcon,
  RotateCcwIcon,
  UsersIcon,
  XIcon
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Spinner
} from '@ki4jlu/design-system'
import { useJobAudioUrl } from '../api'
import { WaveformPlayer } from '../audio'
import { unidentifiedVoiceCount } from '../mapping/speakers'
import { useTranscriptionWorkspace } from '../use-workspace'
import { serverWaveform, type FilePosition, type QueueFile, type QueueGroup } from './queue'
import { errorText, percentText, statusText, TONE } from './texts'
import { useUpload } from './use-upload'

const ICON = { 'aria-hidden': true, className: 'size-4' } as const

export interface FileRowProps {
  file: QueueFile
  position: FilePosition
  /** The whole queue, for the move menu. */
  groups: readonly QueueGroup[]
  /** No moving or removing: a start runs or the group is saved (T-07, T-11). */
  locked: boolean
  processing: boolean
  onOpenMapping: (fileId: string) => void
  onDragStart: (position: FilePosition) => void
  onDragEnd: () => void
  /** Something was dropped on this row: a file of the queue or files from outside (T-07). */
  onDrop: (position: FilePosition, event: DragEvent<HTMLElement>) => void
  onDragOver: (position: FilePosition, event: DragEvent<HTMLElement>) => void
}

/**
 * One file of the queue (kiChat's `multi-upload-item`): a handle to drag it, its player with name,
 * size and length (T-12), the voices to name (T-17), the keyboard way to move it (T-07), removal
 * (T-08), and its progress and status (T-11), with the reason when it failed (T-16).
 */
export function FileRow(props: FileRowProps): React.JSX.Element {
  const { file, position, groups, locked, processing } = props
  const { t, i18n } = useTranslation()
  const { queue, dialogs, start } = useUpload()
  const { capabilities } = useTranscriptionWorkspace()
  const group = groups[position.groupIndex]
  const saved = group?.saved !== null && group?.saved !== undefined
  const unnamed = unidentifiedVoiceCount(file.voices)
  const canMap =
    capabilities?.diarization !== false && file.voices !== null && !file.result && !saved
  const canRetry =
    !saved &&
    ((file.phase === 'analysisFailed' && (file.uploaded || file.file !== null)) ||
      file.phase === 'failed')
  const status = statusText(t, file.status)
  const waveform = serverWaveform(file)

  const remove = async (): Promise<void> => {
    if (queue.removalDeletesJob(file.id)) {
      const confirmed = await dialogs.confirm({
        title: t('transcription.upload.deleteJobTitle'),
        message: t('transcription.upload.confirmDeleteJob', { name: file.name }),
        confirmLabel: t('transcription.common.delete')
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

  return (
    <li
      className="flex flex-col gap-2"
      onDragOver={(event) => props.onDragOver(position, event)}
      onDrop={(event) => props.onDrop(position, event)}
    >
      {/* The actions wrap below the player where the row is too narrow for both. */}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {locked ? null : (
          // The pointer's handle; the move menu beside it is the keyboard's way (T-07).
          <span
            draggable
            aria-hidden="true"
            title={t('transcription.upload.moveFile')}
            className="flex shrink-0 cursor-grab touch-none"
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = 'move'
              event.dataTransfer.setData('text/plain', file.id)
              props.onDragStart(position)
            }}
            onDragEnd={props.onDragEnd}
          >
            <GripVerticalIcon {...ICON} />
          </span>
        )}
        <div className="min-w-0 flex-1 basis-40">
          {file.file ? (
            <WaveformPlayer
              source={file.file}
              name={file.name}
              jobId={waveform?.jobId ?? null}
              jobRevision={waveform?.revision}
              onDuration={(seconds) => queue.setDuration(file.id, seconds)}
            />
          ) : (
            <RestoredPlayer file={file} />
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {canMap ? (
            <Button
              type="button"
              variant={file.voicesSaved ? 'secondary' : 'outline'}
              size="sm"
              disabled={processing}
              aria-label={[
                t('transcription.upload.adjustSpeakersNamed', { name: file.name }),
                unnamed > 0
                  ? t('transcription.upload.unidentifiedSpeakers', { count: unnamed })
                  : null,
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
          {locked ? null : (
            <>
              <MoveMenu file={file} position={position} groups={groups} />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t('transcription.upload.removeFileNamed', { name: file.name })}
                title={t('transcription.upload.removeFile')}
                onClick={() => void remove()}
              >
                <XIcon {...ICON} />
              </Button>
            </>
          )}
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {/*
         * The DS has no Progress component and none may be made up: the row shows a Spinner while
         * it works and the percentage as a Badge, which carries the progressbar role for assistive
         * technology. The status beside it is announced as it changes.
         */}
        {file.tone === 'processing' ? <Spinner size="sm" aria-hidden="true" /> : null}
        <Badge
          appearance="filled"
          tone={TONE[file.tone]}
          role="progressbar"
          aria-label={t('transcription.upload.progressOf', { name: file.name })}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(file.progress)}
        >
          {percentText(i18n.language, file.progress)}
        </Badge>
        <span aria-live="polite" className="min-w-0">
          <Badge appearance="text" tone={TONE[file.tone]}>
            {status}
          </Badge>
        </span>
      </div>
      {file.error ? (
        <Badge appearance="text" tone="error">
          {errorText(t, file.error)}
        </Badge>
      ) : null}
    </li>
  )
}

/** A restored job has no local file: it plays from storage (T-15). */
function RestoredPlayer({ file }: { file: QueueFile }): React.JSX.Element {
  const audio = useJobAudioUrl(file.uploaded ? file.jobId : null)
  const waveform = serverWaveform(file)
  return (
    <WaveformPlayer
      source={audio.data?.url ?? null}
      name={file.name}
      size={file.size}
      jobId={waveform?.jobId ?? null}
      jobRevision={waveform?.revision}
    />
  )
}

/** The keyboard's way to reorder and regroup a file (T-07). */
function MoveMenu({
  file,
  position,
  groups
}: {
  file: QueueFile
  position: FilePosition
  groups: readonly QueueGroup[]
}): React.JSX.Element {
  const { t } = useTranslation()
  const { moveFile } = useUpload()
  const group = groups[position.groupIndex]
  const count = group?.files.length ?? 0
  const targets = groups
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate, index }) => index !== position.groupIndex && candidate.saved === null)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t('transcription.upload.moveFileNamed', { name: file.name })}
          title={t('transcription.upload.moveFile')}
        >
          <ArrowUpDownIcon {...ICON} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{t('transcription.upload.moveFile')}</DropdownMenuLabel>
        <DropdownMenuItem
          disabled={position.fileIndex === 0}
          onSelect={() =>
            moveFile(position, position.groupIndex, Math.max(0, position.fileIndex - 1))
          }
        >
          <ArrowUpIcon {...ICON} />
          {t('transcription.upload.moveUp')}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={position.fileIndex >= count - 1}
          onSelect={() => moveFile(position, position.groupIndex, position.fileIndex + 1)}
        >
          <ArrowDownIcon {...ICON} />
          {t('transcription.upload.moveDown')}
        </DropdownMenuItem>
        {targets.length > 0 ? <DropdownMenuSeparator /> : null}
        {targets.map(({ candidate, index }) => (
          <DropdownMenuItem key={candidate.id} onSelect={() => moveFile(position, index)}>
            <FolderInputIcon {...ICON} />
            {t('transcription.upload.moveToGroup', { name: candidate.name })}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
