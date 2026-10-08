import { useTranslation } from 'react-i18next'
import { Badge } from '@ki4jlu/design-system'
import { allFiles, totalBytes } from './queue'
import { useQueueState } from './use-upload'

/**
 * The file list's title and its total size for the page header, once the queue holds files: the
 * list is what the page shows then, so it takes the page's title instead of a second header under
 * it. A new transcript is added at the end of the list (`UploadView`). `null` while the queue is
 * empty.
 */
export function useFileListHeader(): { title: string; actions: React.JSX.Element } | null {
  const { t } = useTranslation()
  const state = useQueueState()
  const count = allFiles(state.groups).length
  if (count === 0) return null
  return {
    title: `${t('transcription.upload.fileListTitle')} (${count})`,
    actions: (
      <Badge appearance="text" tone="neutral">
        {t('transcription.upload.totalFileSize', {
          size: (totalBytes(state.groups) / (1024 * 1024)).toFixed(1)
        })}
      </Badge>
    )
  }
}
