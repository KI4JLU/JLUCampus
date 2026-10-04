import { createContext, useContext, useSyncExternalStore } from 'react'
import type { UploadDialogs } from './use-dialog-host'
import type { QueueState } from './queue'
import type { UploadQueue } from './store'

export interface UploadContextValue {
  queue: UploadQueue
  dialogs: UploadDialogs
  /**
   * Checks files and adds them to a group (`null`: where dropped files go), with the catalog's
   * alert for those refused (T-04).
   */
  addFiles: (files: readonly File[], groupIndex: number | null) => Promise<void>
  /** Starts the transcription; a single transcript saved without failures opens (T-13). */
  start: () => Promise<void>
}

export const UploadContext = createContext<UploadContextValue | null>(null)

/** The upload queue of the page; only inside `UploadProvider` (`context.tsx`). */
export function useUpload(): UploadContextValue {
  const value = useContext(UploadContext)
  if (!value) throw new Error('useUpload outside UploadProvider')
  return value
}

/** The queue's state, re-rendering on every change. */
export function useQueueState(): QueueState {
  const { queue } = useUpload()
  return useSyncExternalStore(queue.subscribe, queue.getSnapshot)
}
