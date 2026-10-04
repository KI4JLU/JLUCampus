import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useRecording } from './context'
import { formatFileSize } from './wav'

/** Seconds since `startedAt`, ticking while it is set (T-56). */
export function useElapsedSeconds(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAt === null) return
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [startedAt])
  return startedAt === null ? 0 : Math.max(0, (now - startedAt) / 1000)
}

export interface StatusTexts {
  title: string
  text: string
  error: boolean
}

/**
 * What the status says, in kiChat's order (`updateLiveRecordingUI`): the running step first, then
 * an error, then the takes ready to upload, then whether the microphone is ready.
 */
export function useRecordingStatusTexts(): StatusTexts {
  const { t } = useTranslation()
  const { state, takes, microphones } = useRecording()
  const live = state.kind === 'live'
  switch (state.status) {
    case 'recording':
      return live
        ? {
            title: t('transcription.recording.liveRunning'),
            text: t('transcription.recording.liveRunningHint'),
            error: false
          }
        : {
            title: t('transcription.recording.recordingRunning'),
            text: t('transcription.recording.recordingRunningHint'),
            error: false
          }
    case 'requesting':
      return state.step === 'connecting'
        ? {
            title: t('transcription.recording.connecting'),
            text: t('transcription.recording.connectingHint'),
            error: false
          }
        : {
            title: t('transcription.recording.microphonePermission'),
            text: t('transcription.recording.microphonePermissionHint'),
            error: false
          }
    case 'stopping':
      return {
        title: t('transcription.recording.recordingStopping'),
        text: t('transcription.recording.recordingStoppingHint'),
        error: false
      }
    case 'error':
      return {
        title: t('transcription.recording.recordingNotPossible'),
        text: state.error ?? t('transcription.common.unknownError'),
        error: true
      }
    case 'ready':
    case 'idle': {
      const [first] = takes
      if (first)
        return {
          title: t('transcription.recording.recordingReady'),
          text:
            takes.length === 1
              ? `${first.file.name} (${formatFileSize(first.file.size)})`
              : t('transcription.recording.recordingsReadyToUpload', { count: takes.length }),
          error: false
        }
      return microphones.granted
        ? {
            title: t('transcription.recording.microphoneReady'),
            text: t('transcription.recording.selectInputDeviceHint'),
            error: false
          }
        : {
            title: t('transcription.recording.startYourRecording'),
            text: t('transcription.recording.selectMicrophoneBelow'),
            error: false
          }
    }
  }
}
