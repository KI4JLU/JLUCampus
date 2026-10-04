import { useCallback, useMemo, useRef, useState } from 'react'

/**
 * The queue's confirmations and messages, in place of kiChat's `confirmDialog` and `errorDialog`
 * (and its `alert`s): one dialog at a time, each resolving how it was closed.
 */
export interface UploadDialogs {
  /** Resolves `true` when confirmed, `false` when cancelled or closed. */
  confirm: (request: { title: string; message: string; confirmLabel: string }) => Promise<boolean>
  /** Resolves once closed. */
  alert: (request: { title: string; message: string }) => Promise<void>
}

/** The dialog to show: a confirmation or a message. */
export interface DialogRequest {
  kind: 'confirm' | 'alert'
  title: string
  message: string
  confirmLabel?: string
  resolve: (confirmed: boolean) => void
}

/** The dialog state for `UploadDialog`; `close` answers the open request. */
export function useDialogHost(): {
  dialogs: UploadDialogs
  request: DialogRequest | null
  close: (confirmed: boolean) => void
} {
  const [request, setRequest] = useState<DialogRequest | null>(null)
  const current = useRef<DialogRequest | null>(null)

  const open = useCallback((next: Omit<DialogRequest, 'resolve'>): Promise<boolean> => {
    // A newer dialog answers the one still open as cancelled.
    current.current?.resolve(false)
    return new Promise((resolve) => {
      const entry = { ...next, resolve }
      current.current = entry
      setRequest(entry)
    })
  }, [])

  const close = useCallback((confirmed: boolean): void => {
    const entry = current.current
    current.current = null
    setRequest(null)
    entry?.resolve(confirmed)
  }, [])

  const dialogs = useMemo<UploadDialogs>(
    () => ({
      confirm: (input) => open({ kind: 'confirm', ...input }),
      alert: async (input) => {
        await open({ kind: 'alert', ...input })
      }
    }),
    [open]
  )

  return { dialogs, request, close }
}
