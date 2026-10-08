import { PlusIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge, Button } from '@ki4jlu/design-system'
import { allFiles, totalBytes } from './queue'
import { useQueueState, useUpload } from './use-upload'

const ICON = { 'aria-hidden': true, className: 'size-4' } as const

/**
 * The file list's title and its actions for the page header, once the queue holds files: the list
 * is what the page shows then, so it takes the page's title instead of a second header under it.
 * `null` while the queue is empty.
 */
export function useFileListHeader(): { title: string; actions: React.JSX.Element } | null {
  const { t } = useTranslation()
  const { queue } = useUpload()
  const state = useQueueState()
  const count = allFiles(state.groups).length
  if (count === 0) return null
  return {
    title: `${t('transcription.upload.fileListTitle')} (${count})`,
    actions: (
      <>
        <Badge appearance="text" tone="neutral">
          {t('transcription.upload.totalFileSize', {
            size: (totalBytes(state.groups) / (1024 * 1024)).toFixed(1)
          })}
        </Badge>
        {/* Open during a start too, as kiChat's; the start leaves the new group alone. */}
        <Button type="button" variant="outline" size="sm" onClick={() => queue.addGroup()}>
          <PlusIcon {...ICON} />
          {t('transcription.upload.addTranscript')}
        </Button>
      </>
    )
  }
}
