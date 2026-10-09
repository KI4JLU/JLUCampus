import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useFeature } from '@/lib/features'
import type { ExportCategory } from './files'
import type { SpeakerLabels } from './format'
import { useExportState } from './store'

/**
 * The export category shown: the one chosen, except the summary for a user whose roles do not
 * allow AI summaries, who gets the transcript instead.
 */
export function useExportCategory(): ExportCategory {
  const { category } = useExportState()
  const summaries = useFeature('transcription.summaries')
  return category === 'summary' && !summaries ? 'transcript' : category
}

/** The names the export gives speakers without one, in the current language. */
export function useSpeakerLabels(): SpeakerLabels {
  const { t, i18n } = useTranslation()
  return useMemo(
    () => ({
      unknown: t('transcription.common.unknown'),
      unknownN: (n: number) => t('transcription.export.unknownSpeakerN', { n }),
      voice: (n: number) => t('transcription.common.speakerN', { n }),
      anonymous: (n: number) => t('transcription.export.anonymousSpeaker', { n })
    }),
    // The texts change with the language.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, i18n.language]
  )
}
