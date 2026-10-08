import { useId, useRef, useState, type DragEvent } from 'react'
import { PlayIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button, FileDropzone, Spinner } from '@ki4jlu/design-system'
import { TRANSCRIPTION_MAX_FILE_BYTES } from '@justcampus/shared'
import { SpeakerMappingDialog } from '../mapping'
import { useTranscriptionWorkspace } from '../use-workspace'
import { GroupBlock } from './group-block'
import { allFiles, type FilePosition } from './queue'
import { useQueueState, useUpload } from './use-upload'
import { limitMegabytes } from './validation'

const ICON = { 'aria-hidden': true, className: 'size-4' } as const

/**
 * The work area of the `upload` view, after kiChat's file view: the drop area with the file
 * chooser (T-03), the queue of transcript groups (T-05 to T-08, T-11, T-12) and the start (T-13).
 * Rows and groups take files dragged within the queue or from outside. Files dropped anywhere else
 * in the view go where the drop area puts them (kiChat's drop handling on the whole file view).
 */
export function UploadView(): React.JSX.Element {
  const { t } = useTranslation()
  const headingId = useId()
  const { addFiles, moveFile, start } = useUpload()
  const state = useQueueState()
  const { capabilities } = useTranscriptionWorkspace()
  const input = useRef<HTMLInputElement>(null)
  const targetGroup = useRef<number | null>(null)
  const dragged = useRef<FilePosition | null>(null)
  const [dropTarget, setDropTarget] = useState<number | null>(null)
  const [mappingFile, setMappingFile] = useState<string | null>(null)

  const files = allFiles(state.groups)
  const maxBytes = capabilities?.limits.maxFileBytes ?? TRANSCRIPTION_MAX_FILE_BYTES
  const maxHint =
    maxBytes === TRANSCRIPTION_MAX_FILE_BYTES
      ? t('transcription.upload.maxFileSize')
      : t('transcription.upload.maxFileSizeLimit', { size: limitMegabytes(maxBytes) })

  /** Opens the file chooser for a group, or for where dropped files go. */
  const choose = (groupIndex: number | null): void => {
    targetGroup.current = groupIndex
    input.current?.click()
  }

  /** A drag over a group or row: files from outside are copied, a queue file is moved. */
  const dragOver = (groupIndex: number, event: DragEvent<HTMLElement>): void => {
    if (state.processing || state.groups[groupIndex]?.saved) return
    const external = dragged.current === null
    if (external && !event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = external ? 'copy' : 'move'
    if (dropTarget !== groupIndex) setDropTarget(groupIndex)
  }

  /** Files from outside dropped anywhere else in the view; ignored while a start runs (kiChat). */
  const viewDragOver = (event: DragEvent<HTMLElement>): void => {
    if (event.defaultPrevented || dragged.current !== null) return
    if (!event.dataTransfer.types.includes('Files')) return
    // Also while a start runs, so the browser does not open the file instead of the page.
    event.preventDefault()
    event.dataTransfer.dropEffect = state.processing ? 'none' : 'copy'
  }

  const viewDrop = (event: DragEvent<HTMLElement>): void => {
    // The drop area, groups and rows took theirs already.
    if (event.defaultPrevented || dragged.current !== null) return
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    if (state.processing || event.dataTransfer.files.length === 0) return
    void addFiles(Array.from(event.dataTransfer.files), null)
  }

  const drop = (
    groupIndex: number,
    fileIndex: number | null,
    event: DragEvent<HTMLElement>
  ): void => {
    if (state.processing || state.groups[groupIndex]?.saved) return
    event.preventDefault()
    event.stopPropagation()
    setDropTarget(null)
    const from = dragged.current
    dragged.current = null
    if (from) moveFile(from, groupIndex, fileIndex)
    else if (event.dataTransfer.files.length > 0) {
      void addFiles(Array.from(event.dataTransfer.files), groupIndex)
    }
  }

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-stack-md"
      onDragOver={viewDragOver}
      onDrop={viewDrop}
    >
      <h2 id={headingId} className="sr-only">
        {t('transcription.common.choiceUploadTitle')}
      </h2>
      {files.length > 0 ? (
        <>
          {state.groups.map((group, index) => (
            <GroupBlock
              key={group.id}
              group={group}
              index={index}
              state={state}
              dropTarget={dropTarget === index}
              onAddFile={choose}
              onOpenMapping={setMappingFile}
              onDragStart={(position) => {
                dragged.current = position
              }}
              onDragEnd={() => {
                dragged.current = null
                setDropTarget(null)
              }}
              onDragOver={(groupIndex, _fileIndex, event) => dragOver(groupIndex, event)}
              onDrop={drop}
            />
          ))}
        </>
      ) : null}

      {state.processing ? null : (
        // The whole area opens the chooser, as kiChat's; its "button" is only the look of one, so
        // no control sits inside another. Slim as kiChat's: no icon, the hint on one line.
        // DS gap: FileDropzone has no way to leave out its icon (`null` gives the default cloud);
        // `false` renders nothing in the slot.
        <FileDropzone
          icon={false}
          className="py-3"
          onBrowse={() => choose(null)}
          onFiles={(dropped) => {
            if (dragged.current === null) void addFiles(dropped, null)
          }}
          title={
            <span className="flex flex-wrap items-center justify-center gap-2">
              {t('transcription.upload.dropZoneText')}
              <Button asChild size="sm">
                <span>{t('transcription.upload.selectFromComputer')}</span>
              </Button>
            </span>
          }
          hint={`${t('transcription.upload.supportedFormats')} ${maxHint}`}
        />
      )}

      {files.length > 0 ? (
        <div className="flex justify-center">
          <Button type="button" size="lg" disabled={state.processing} onClick={() => void start()}>
            {state.processing ? (
              <Spinner size="sm" label={t('transcription.common.inProgress')} />
            ) : (
              <PlayIcon {...ICON} />
            )}
            {state.processing
              ? t('transcription.common.inProgress')
              : t('transcription.upload.startTranscription')}
          </Button>
        </div>
      ) : null}

      {/*
       * The chooser behind the drop area and each group's "Add file". Like kiChat's it lists all
       * files (T-03); the queue checks each file after the choice and names the refused ones (T-04).
       */}
      {/* eslint-disable-next-line design-system/no-raw-ui-elements -- a hidden file input, opened by DS buttons */}
      <input
        ref={input}
        type="file"
        multiple
        hidden
        tabIndex={-1}
        onChange={(event) => {
          const chosen = Array.from(event.target.files ?? [])
          event.target.value = ''
          if (chosen.length > 0) void addFiles(chosen, targetGroup.current)
          targetGroup.current = null
        }}
      />

      <SpeakerMappingDialog fileId={mappingFile} onOpenChange={() => setMappingFile(null)} />
    </section>
  )
}
