import type { ReactNode } from 'react'

/**
 * Upload area (stream "upload"): the upload view with dropzone, queue groups, validation, upload
 * and analysis progress, preview players, start, merge and save, restored active jobs (T-03 to
 * T-16), and the upload settings (T-09).
 */

/**
 * Holds the upload queue for as long as the page lives, so it survives switching views. It wraps
 * the whole page, side column included.
 */
export function UploadProvider({ children }: { children: ReactNode }): React.JSX.Element {
  return <>{children}</>
}

/** The work area of the `upload` view. */
export function UploadView(): React.JSX.Element | null {
  return null
}

/** The upload settings in the side column (language, speaker count, correction). */
export function UploadSettings(): React.JSX.Element | null {
  return null
}
