import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import {
  TRANSCRIPTION_GROUP_FILES_MAX,
  TRANSCRIPTION_MAX_FILE_BYTES,
  type TranscriptionTranscript
} from '@justcampus/shared'
import {
  analyzeJob,
  createJob,
  createTranscript,
  deleteJob,
  dispatchJob,
  getJob,
  getTranscript,
  listJobs,
  patchTranscript,
  transcriptionKeys,
  uploadToSignedUrl
} from '../api'
import { useTranscriptionWorkspace } from '../use-workspace'
import { UploadDialog } from './dialogs'
import { useDialogHost } from './use-dialog-host'
import { dropTargetIndex, type FilePosition } from './queue'
import { UploadQueue, type QueueLabels } from './store'
import { UploadContext } from './use-upload'
import { limitMegabytes, partitionFiles } from './validation'

/** The automatic labels the queue gives voices and samples, in the UI language. */
function labelsOf(t: TFunction): QueueLabels {
  return {
    autoLabel: (n) => t('transcription.common.speakerN', { n }),
    sampleLabel: (n) => t('transcription.upload.sampleN', { n })
  }
}

/** A local file's length from its metadata, as kiChat measures it on selection (T-05). */
function measureDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const audio = document.createElement('audio')
    const url = URL.createObjectURL(file)
    const done = (duration: number | null): void => {
      clearTimeout(timer)
      audio.removeAttribute('src')
      URL.revokeObjectURL(url)
      resolve(duration)
    }
    const timer = setTimeout(() => done(null), 15_000)
    audio.preload = 'metadata'
    audio.onloadedmetadata = () => done(Number.isFinite(audio.duration) ? audio.duration : null)
    audio.onerror = () => done(null)
    audio.src = url
  })
}

/**
 * Holds the upload queue for as long as the page lives, so it survives switching views; it wraps
 * the whole page, side column included. On arrival it restores the user's active jobs (T-15),
 * takes the files other areas hand over (recorded takes, T-58) and, back at the entry choice,
 * clears the selection unless a start runs (T-01).
 */
export function UploadProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const { t } = useTranslation()
  const client = useQueryClient()
  const workspace = useTranscriptionWorkspace()
  const { dialogs, request, close } = useDialogHost()
  const view = useRef(workspace.view)
  useEffect(() => {
    view.current = workspace.view
  })

  // Kept in the page's memory, so uploads and polling go on through a remount of the page.
  const { memory } = workspace
  const [queue] = useState(() => {
    const cell = memory.cell<UploadQueue | null>('upload.queue', () => null)
    if (cell.value) return cell.value
    const created = new UploadQueue({
      api: {
        listJobs,
        createJob,
        getJob,
        analyzeJob,
        dispatchJob,
        deleteJob,
        createTranscript,
        getTranscript,
        patchTranscript
      },
      upload: uploadToSignedUrl,
      settings: workspace.uploadSettings,
      labels: labelsOf(t),
      measureDuration,
      onJobsChanged: () => void client.invalidateQueries({ queryKey: transcriptionKeys.jobs }),
      onTranscriptSaved: (transcript) => {
        client.setQueryData(transcriptionKeys.transcript(transcript.id), transcript)
        void client.invalidateQueries({ queryKey: transcriptionKeys.transcripts })
        void client.invalidateQueries({ queryKey: transcriptionKeys.jobs })
      },
      latestRevision: (id) =>
        client.getQueryData<TranscriptionTranscript>(transcriptionKeys.transcript(id))?.revision ??
        null
    })
    cell.value = created
    memory.onDispose(() => created.dispose())
    return created
  })

  const { capabilities, openTranscript } = workspace
  const maxBytes = capabilities?.limits.maxFileBytes ?? TRANSCRIPTION_MAX_FILE_BYTES
  // A saved transcript combines at most this many files; the server says if the admin set fewer.
  const maxFiles = capabilities?.limits.maxFilesPerGroup ?? TRANSCRIPTION_GROUP_FILES_MAX

  useEffect(() => {
    queue.configure({
      settings: workspace.uploadSettings,
      labels: labelsOf(t),
      maxFilesPerGroup: maxFiles
    })
  }, [maxFiles, queue, t, workspace.uploadSettings])

  useEffect(() => {
    queue.attach()
  }, [queue])

  /** The catalog's alert for refused files, with their names; the admin's limit if changed. */
  const checkFiles = useCallback(
    async (files: readonly File[]): Promise<File[]> => {
      const { accepted, rejected } = partitionFiles(files, maxBytes)
      if (rejected.length > 0) {
        const alert =
          maxBytes === TRANSCRIPTION_MAX_FILE_BYTES
            ? t('transcription.upload.unsupportedFileAlert')
            : t('transcription.upload.unsupportedFileAlertLimit', {
                size: limitMegabytes(maxBytes)
              })
        const names = rejected.map(({ file }) => `"${file.name}"`).join(', ')
        await dialogs.alert({
          title: t('transcription.common.error'),
          message: `${alert}\n\n${t('transcription.upload.rejectedFiles', { names })}`
        })
      }
      return accepted
    },
    [dialogs, maxBytes, t]
  )

  /** Files beyond the admin's limit per transcript are not added; the alert says so. */
  const fitGroup = useCallback(
    async (files: File[], present: number): Promise<File[]> => {
      if (present + files.length <= maxFiles) return files
      await dialogs.alert({
        title: t('transcription.common.error'),
        message: t('transcription.upload.groupFull', { count: maxFiles })
      })
      return files.slice(0, Math.max(0, maxFiles - present))
    },
    [dialogs, maxFiles, t]
  )

  const addFiles = useCallback(
    async (files: readonly File[], groupIndex: number | null): Promise<void> => {
      const accepted = await checkFiles(files)
      if (accepted.length === 0) return
      const groups = queue.getSnapshot().groups
      const present = groups[groupIndex ?? dropTargetIndex(groups)]?.files.length ?? 0
      queue.addFiles(await fitGroup(accepted, present), groupIndex)
    },
    [checkFiles, fitGroup, queue]
  )

  /** Moves a file; one refused because the target group is full gets the catalog's alert. */
  const moveFile = useCallback(
    (from: FilePosition, toGroupIndex: number, toFileIndex: number | null = null): void => {
      if (queue.moveFile(from, toGroupIndex, toFileIndex) || queue.getSnapshot().processing) return
      void dialogs.alert({
        title: t('transcription.common.error'),
        message: t('transcription.upload.groupFull', { count: maxFiles })
      })
    },
    [dialogs, maxFiles, queue, t]
  )

  const start = useCallback(async (): Promise<void> => {
    const outcome = await queue.start()
    if (outcome.status === 'empty') {
      await dialogs.alert({
        title: t('transcription.common.error'),
        message: t('transcription.upload.addFileFirst')
      })
      return
    }
    const [only] = outcome.savedIds
    if (outcome.savedIds.length === 1 && only && !outcome.failed && view.current === 'upload') {
      await openTranscript(only)
    }
  }, [dialogs, openTranscript, queue, t])

  // Files handed over by other areas join the queue as a group of their own, once it takes files.
  const { pendingUploads, takePendingUploads } = workspace
  const processing = useSyncExternalStore(queue.subscribe, () => queue.getSnapshot().processing)
  useEffect(() => {
    if (pendingUploads.length === 0 || processing) return
    void (async () => {
      for (const pending of takePendingUploads()) {
        const accepted = await fitGroup(await checkFiles(pending.files), 0)
        queue.addGroupOfFiles(accepted, pending.title)
      }
    })()
  }, [checkFiles, fitGroup, pendingUploads, processing, queue, takePendingUploads])

  useEffect(() => {
    queue.showView(workspace.view)
  }, [queue, workspace.view])

  const value = useMemo(
    () => ({ queue, dialogs, addFiles, moveFile, start }),
    [addFiles, dialogs, moveFile, queue, start]
  )
  return (
    <UploadContext.Provider value={value}>
      {children}
      <UploadDialog request={request} onClose={close} />
    </UploadContext.Provider>
  )
}
