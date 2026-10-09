import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@ki4jlu/design-system'
import { formatTime } from '../audio'
import { Notice } from '../notice'
import type { StoredRecording } from './backup-store'
import { useRecording } from './context'
import { formatFileSize } from './files'

/** The recordings a crash, reload or leaving the page left in the backup, and a failed restore. */
export function LeftoverNotices(): React.JSX.Element {
  const { backup } = useRecording()
  return (
    <>
      {backup.leftoverError ? <Notice tone="error">{backup.leftoverError}</Notice> : null}
      {backup.leftovers.map((leftover) => (
        <LeftoverNotice key={leftover.id} leftover={leftover} />
      ))}
    </>
  )
}

/**
 * The backup of the running or last take failed; the take itself is complete. When only its
 * separate tracks could not be backed up, the mix is safe, and the notice says just that.
 */
export function BackupFailedNotice(): React.JSX.Element | null {
  const { t } = useTranslation()
  const { backup } = useRecording()
  if (backup.failed)
    return <Notice tone="warning">{t('transcription.recording.backup.failed')}</Notice>
  if (backup.tracksFailed)
    return <Notice tone="info">{t('transcription.recording.backup.tracksFailed')}</Notice>
  return null
}

/** A recording left in the backup: add it to the takes, or discard it after asking once more. */
function LeftoverNotice({ leftover }: { leftover: StoredRecording }): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const { backup } = useRecording()
  const [armed, setArmed] = useState(false)
  const [pending, setPending] = useState(false)
  const discardRef = useRef<HTMLButtonElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const started = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(leftover.startedAt)
      ),
    [i18n.language, leftover.startedAt]
  )

  const run = (action: () => Promise<void>): void => {
    setPending(true)
    void action().finally(() => setPending(false))
  }
  const arm = (): void => {
    setArmed(true)
    requestAnimationFrame(() => confirmRef.current?.focus())
  }
  const disarm = (): void => {
    setArmed(false)
    requestAnimationFrame(() => discardRef.current?.focus())
  }

  return (
    <Notice
      tone="warning"
      title={t('transcription.recording.backup.leftoverTitle')}
      action={
        <div className="flex flex-wrap items-center gap-stack-sm">
          {armed ? (
            <>
              <Button
                ref={confirmRef}
                type="button"
                variant="destructive"
                disabled={pending}
                onClick={() => run(() => backup.discard(leftover.id))}
              >
                {t('transcription.recording.backup.confirmDiscard')}
              </Button>
              <Button type="button" variant="outline" disabled={pending} onClick={disarm}>
                {t('transcription.recording.backup.cancelDiscard')}
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                disabled={pending}
                onClick={() => run(() => backup.restore(leftover.id))}
              >
                {t('transcription.recording.backup.restore')}
              </Button>
              <Button
                ref={discardRef}
                type="button"
                variant="destructive-outline"
                disabled={pending}
                onClick={arm}
              >
                {t('transcription.recording.backup.discard')}
              </Button>
            </>
          )}
        </div>
      }
    >
      {t('transcription.recording.backup.leftoverDetails', {
        started,
        duration: formatTime(leftover.duration ?? 0),
        size: formatFileSize(leftover.size)
      })}
    </Notice>
  )
}
