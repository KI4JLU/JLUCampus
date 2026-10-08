import { useSyncExternalStore, type DragEvent } from 'react'
import { FilePlusIcon, FileTextIcon, FolderIcon, Trash2Icon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button, Card, CardContent, CardHeader, CardTitle, Input } from '@ki4jlu/design-system'
import { TRANSCRIPTION_TITLE_MAX } from '@justcampus/shared'
import { toast } from '@/lib/toast'
import { useTranscriptionWorkspace } from '../use-workspace'
import { FileRow } from './file-row'
import { Notice } from '../notice'
import { groupLocked, type FilePosition, type QueueGroup, type QueueState } from './queue'
import { useUpload } from './use-upload'

const ICON = { 'aria-hidden': true, className: 'size-4' } as const

/** kiChat shortens a group's transcript link to 25 characters. */
function linkTitle(title: string): string {
  return title.length > 25 ? `${title.slice(0, 22)}...` : title
}

export interface GroupBlockProps {
  group: QueueGroup
  index: number
  state: QueueState
  /** Highlighted while something dragged may be dropped here. */
  dropTarget: boolean
  onAddFile: (groupIndex: number) => void
  onOpenMapping: (fileId: string) => void
  onDragStart: (position: FilePosition) => void
  onDragEnd: () => void
  onDragOver: (groupIndex: number, fileIndex: number | null, event: DragEvent<HTMLElement>) => void
  onDrop: (groupIndex: number, fileIndex: number | null, event: DragEvent<HTMLElement>) => void
}

/**
 * One transcript group (T-06): its editable name, adding a file and deleting the group, its files,
 * and once saved the way to its transcript (kiChat's `renderGroupTranscriptLinks`). Files dragged
 * onto it from the queue or from outside join it (T-07).
 */
export function GroupBlock(props: GroupBlockProps): React.JSX.Element {
  const { group, index, state } = props
  const { t } = useTranslation()
  const { queue, dialogs } = useUpload()
  const { openTranscript } = useTranscriptionWorkspace()
  // While its transcript is being saved, the group and its files can be neither removed nor moved.
  const saving = useSyncExternalStore(queue.subscribe, () => queue.isSaving(group.id))
  const locked = groupLocked(state, group) || saving
  const hasBody = group.saveConflict || group.saveFailed || group.files.length > 0

  const commitName = async (): Promise<void> => {
    if (!(await queue.commitGroupName(group.id))) {
      toast({ variant: 'error', title: t('transcription.upload.titleSaveFailed') })
    }
  }

  const removeGroup = async (): Promise<void> => {
    const jobFiles = group.files.filter((file) => file.jobId !== null)
    if (jobFiles.length > 0) {
      const names = jobFiles.map((file) => `"${file.name}"`).join(', ')
      const confirmed = await dialogs.confirm({
        title: t('transcription.upload.deleteTranscriptGroup'),
        message: t('transcription.upload.confirmDeleteGroup', { names }),
        confirmLabel: t('transcription.common.confirm')
      })
      if (!confirmed) return
    }
    if (!(await queue.removeGroup(group.id))) {
      await dialogs.alert({
        title: t('transcription.common.error'),
        message: t('transcription.upload.deleteGroupFailed')
      })
    }
  }

  return (
    <Card
      role="group"
      aria-label={group.name}
      accent={props.dropTarget}
      className="overflow-hidden"
      onDragOver={(event) => props.onDragOver(index, null, event)}
      onDrop={(event) => props.onDrop(index, null, event)}
    >
      {/*
       * The header names the folder: its name takes the card title's type (CardTitle hands its type
       * tokens to the inline field), and the band is tinted, so it reads apart from the files below.
       * The band is slim, as kiChat's: its height is that of the icon buttons, which the title's
       * line does not exceed.
       * DS gap: CardHeader has no tone; the tint is the primary/10 of a pressed outline button, the
       * card clips it to its corners.
       */}
      <CardHeader className="flex-row flex-wrap items-center gap-2 bg-primary/10 px-4 py-2">
        <FolderIcon aria-hidden className="size-5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <CardTitle asChild>
            <Input
              variant="inline"
              value={group.name}
              maxLength={TRANSCRIPTION_TITLE_MAX}
              aria-label={t('transcription.upload.groupName')}
              onChange={(event) => queue.renameGroup(group.id, event.target.value)}
              onBlur={() => void commitName()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  event.currentTarget.blur()
                }
              }}
            />
          </CardTitle>
        </div>
        {group.saved ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            title={group.saved.title}
            onClick={() => void openTranscript(group.saved!.id)}
          >
            <FileTextIcon {...ICON} />
            {t('transcription.upload.openItem', { title: linkTitle(group.saved.title) })}
          </Button>
        ) : (
          <>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={locked}
              aria-label={t('transcription.upload.addFileTo', { name: group.name })}
              title={t('transcription.upload.addFile')}
              onClick={() => props.onAddFile(index)}
            >
              <FilePlusIcon {...ICON} />
            </Button>
            {/* Open during a start too: kiChat cancels the group's jobs then. */}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={saving}
              aria-label={t('transcription.upload.deleteGroupNamed', { name: group.name })}
              title={t('transcription.upload.deleteTranscriptGroup')}
              onClick={() => void removeGroup()}
            >
              <Trash2Icon {...ICON} />
            </Button>
          </>
        )}
      </CardHeader>
      {hasBody ? (
        <CardContent className="flex flex-col gap-stack-sm p-4">
          {group.saveConflict ? (
            <Notice tone="warning" title={t('transcription.upload.saveFailed')}>
              {t(`transcription.upload.saveConflict.${group.saveConflict}`)}
            </Notice>
          ) : null}
          {group.saveFailed ? (
            <Notice
              tone="error"
              title={t('transcription.upload.saveFailed')}
              action={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={state.processing || saving}
                  onClick={() => void queue.saveGroup(group.id)}
                >
                  {t('transcription.common.retry')}
                </Button>
              }
            />
          ) : null}
          {group.files.length > 0 ? (
            <ul className="m-0 flex list-none flex-col gap-3 p-0">
              {group.files.map((file, fileIndex) => (
                <FileRow
                  key={file.id}
                  file={file}
                  position={{ groupIndex: index, fileIndex }}
                  saved={group.saved !== null}
                  locked={locked}
                  saving={saving}
                  processing={state.processing}
                  onOpenMapping={props.onOpenMapping}
                  onDragStart={props.onDragStart}
                  onDragEnd={props.onDragEnd}
                  onDragOver={(position, event) =>
                    props.onDragOver(position.groupIndex, position.fileIndex, event)
                  }
                  onDrop={(position, event) =>
                    props.onDrop(position.groupIndex, position.fileIndex, event)
                  }
                />
              ))}
            </ul>
          ) : null}
        </CardContent>
      ) : null}
    </Card>
  )
}
