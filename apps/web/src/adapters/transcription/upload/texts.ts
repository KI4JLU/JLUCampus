import type { TFunction } from 'i18next'
import type { BadgeProps } from '@ki4jlu/design-system'
import type { FileError, RowTone, StatusKey } from './queue'

/** The status line of a row in the UI language (T-11). */
export function statusText(t: TFunction, status: StatusKey): string {
  switch (status) {
    case 'ready':
      return t('transcription.common.ready')
    case 'preprocessing':
      return t('transcription.common.preprocessing')
    case 'preparing':
      return t('transcription.common.preparing')
    case 'transcribing':
      return t('transcription.common.transcribing')
    case 'inProgress':
      return t('transcription.common.inProgress')
    case 'done':
      return t('transcription.common.done')
    case 'failed':
      return t('transcription.common.failed')
    default:
      return t(`transcription.upload.${status}`)
  }
}

/**
 * Why a row failed, as kiChat words it (T-16): its message, then the server's detail. Messages
 * ending in a colon introduce the detail, which is `Unbekannt` when the server gave none.
 */
export function errorText(t: TFunction, error: FileError): string {
  const base =
    error.key === 's3UploadFailed'
      ? t('transcription.upload.s3UploadFailed', { status: error.status ?? 0 })
      : error.key === 'noServerResponse'
        ? t('transcription.common.noServerResponse')
        : t(`transcription.upload.${error.key}`)
  const detail = error.message?.trim() ?? ''
  if (base.endsWith(': ')) return `${base}${detail || t('transcription.common.unknown')}`
  return detail ? `${base} ${detail}` : base
}

/** The badge tone of a row's look. */
export const TONE: Record<RowTone, NonNullable<BadgeProps['tone']>> = {
  ready: 'neutral',
  processing: 'primary',
  error: 'error',
  success: 'success'
}
