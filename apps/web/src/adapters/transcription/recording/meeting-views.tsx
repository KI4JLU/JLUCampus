import { useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  Label,
  PanelSection
} from '@ki4jlu/design-system'
import { formatTime } from '../audio'
import { Notice } from '../notice'
import { useRecording } from './context'
import type { StoredMeeting } from './meeting-store'
import { isRecordingBusy } from './state'
import {
  RecordingControls,
  RecordingSettings,
  RecordingStatusCard,
  RecordingTabs,
  TakeList
} from './views'
import { formatFileSize } from './wav'

const HOW_TO_STEPS = ['open', 'pick', 'share', 'keep'] as const

/**
 * The work area of the `meeting` view: the user's microphone and another tab's audio (e.g. a
 * BigBlueButton meeting) recorded as one take. Before a recording it says how, why a headset,
 * and asks for everyone's consent; recordings a crash left behind are offered first.
 */
export function MeetingView(): React.JSX.Element {
  const { t } = useTranslation()
  const { state, meeting } = useRecording()
  return (
    <RecordingTabs current="meeting">
      {meeting.support === 'supported' ? null : (
        <Notice tone="warning" title={t('transcription.recording.meeting.unsupportedTitle')}>
          {meeting.support === 'desktop'
            ? t('transcription.recording.meeting.unsupportedDesktop')
            : t('transcription.recording.meeting.unsupported')}
        </Notice>
      )}
      {meeting.leftoverError ? <Notice tone="error">{meeting.leftoverError}</Notice> : null}
      {meeting.leftovers.map((leftover) => (
        <LeftoverNotice key={leftover.id} leftover={leftover} />
      ))}
      {meeting.backupFailed ? (
        <Notice tone="warning">{t('transcription.recording.meeting.backupFailed')}</Notice>
      ) : null}
      <RecordingStatusCard kind="meeting" />
      {isRecordingBusy(state.status) ? null : <MeetingPreparation />}
      <RecordingControls kind="meeting" />
      <TakeList />
    </RecordingTabs>
  )
}

/** How to share the tab, the headset advice and the consent that unlocks the start. */
function MeetingPreparation(): React.JSX.Element {
  const { t } = useTranslation()
  const { meeting } = useRecording()
  const id = useId()
  return (
    <Card>
      <CardHeader>
        <CardTitle asChild>
          <h2>{t('transcription.recording.meeting.howToTitle')}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-stack-md">
        <ol className="m-0 flex list-decimal flex-col gap-1 pl-5">
          {HOW_TO_STEPS.map((step) => (
            <li key={step}>{t(`transcription.recording.meeting.howToSteps.${step}`)}</li>
          ))}
        </ol>
        <Notice tone="info" inline title={t('transcription.recording.meeting.headsetTitle')}>
          {t('transcription.recording.meeting.headset')}
        </Notice>
        <Notice tone="warning" inline title={t('transcription.recording.meeting.legalTitle')}>
          {t('transcription.recording.meeting.legal')}
        </Notice>
        <div className="flex items-start gap-3">
          <Checkbox
            id={`${id}-consent`}
            checked={meeting.consented}
            disabled={meeting.support !== 'supported'}
            aria-required="true"
            aria-describedby={`${id}-consent-hint`}
            onCheckedChange={(checked) => meeting.setConsented(checked === true)}
          />
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${id}-consent`}>{t('transcription.recording.meeting.consent')}</Label>
            <p id={`${id}-consent-hint`} className="m-0">
              {t('transcription.recording.meeting.consentHint')}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

/** A recording left in the backup: add it to the takes, or discard it after asking once more. */
function LeftoverNotice({ leftover }: { leftover: StoredMeeting }): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const { meeting } = useRecording()
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
      title={t('transcription.recording.meeting.leftoverTitle')}
      action={
        <div className="flex flex-wrap items-center gap-stack-sm">
          {armed ? (
            <>
              <Button
                ref={confirmRef}
                type="button"
                variant="destructive"
                disabled={pending}
                onClick={() => run(() => meeting.discard(leftover.id))}
              >
                {t('transcription.recording.meeting.confirmDiscard')}
              </Button>
              <Button type="button" variant="outline" disabled={pending} onClick={disarm}>
                {t('transcription.recording.meeting.cancelDiscard')}
              </Button>
            </>
          ) : (
            <>
              <Button
                type="button"
                disabled={pending}
                onClick={() => run(() => meeting.restore(leftover.id))}
              >
                {t('transcription.recording.meeting.restore')}
              </Button>
              <Button
                ref={discardRef}
                type="button"
                variant="destructive-outline"
                disabled={pending}
                onClick={arm}
              >
                {t('transcription.recording.meeting.discard')}
              </Button>
            </>
          )}
        </div>
      }
    >
      {t('transcription.recording.meeting.leftoverDetails', {
        started,
        duration: formatTime(leftover.duration ?? 0),
        size: formatFileSize(leftover.size)
      })}
    </Notice>
  )
}

/** The side column of the `meeting` view: status and microphone as for recording, and the backup. */
export function MeetingSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const { meeting } = useRecording()
  return (
    <>
      <RecordingSettings kind="meeting" />
      <PanelSection title={t('transcription.recording.meeting.backupTitle')}>
        {meeting.backupFailed ? (
          <Notice tone="warning" inline>
            {t('transcription.recording.meeting.backupFailed')}
          </Notice>
        ) : (
          <p className="m-0">{t('transcription.recording.meeting.backup')}</p>
        )}
      </PanelSection>
    </>
  )
}
