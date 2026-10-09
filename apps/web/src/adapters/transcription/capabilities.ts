import { useMemo } from 'react'
import type { TranscriptionCapabilities } from '@justcampus/shared'
import { useFeature } from '@/lib/features'
import { useTranscriptionCapabilities } from './api'

/** The capabilities without live transcription, for a user whose roles do not allow it. */
export function withoutLive(capabilities: TranscriptionCapabilities): TranscriptionCapabilities {
  return { ...capabilities, realtimeModes: [], defaultRealtimeMode: null }
}

/**
 * What the module offers the signed-in user: as `useTranscriptionCapabilities`, but live
 * transcription only when their roles allow it, so the page leaves it out as if it were not set
 * up. `undefined` while loading or when the module does not answer.
 */
export function useOfferedCapabilities(): TranscriptionCapabilities | undefined {
  const live = useFeature('transcription.live')
  const capabilities = useTranscriptionCapabilities().data
  return useMemo(
    () => (capabilities && !live ? withoutLive(capabilities) : capabilities),
    [capabilities, live]
  )
}
