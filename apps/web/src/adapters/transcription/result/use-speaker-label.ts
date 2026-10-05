import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { speakerLabel } from '../segments'

/** Shows a stored speaker name: automatic ones in the UI language, typed ones as they are. */
export function useSpeakerLabel(): (name: string) => string {
  const { t } = useTranslation()
  return useCallback(
    (name: string) =>
      speakerLabel(name, {
        unknown: (n) => t('transcription.result.unknownSpeakerN', { n }),
        voice: (n) => t('transcription.common.speakerN', { n })
      }),
    [t]
  )
}
