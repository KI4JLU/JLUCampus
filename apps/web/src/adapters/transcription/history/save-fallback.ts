import { useEffect } from 'react'
import { onTranscriptCreate } from '../api'
import { changeLocalHistory, recordSaveOutcome } from './local-store'

/**
 * Keeps a transcript whose save did not reach the server in the signed-in user's local history of
 * the module (T-39, kiChat's `saveProcessedFile`): it is listed as "only on this device" and opens
 * after a reload. A later successful retry of the same save removes that copy again. `key` is the
 * history's storage key, `null` while the user is not known.
 */
export function useLocalSaveFallback(key: string | null): void {
  useEffect(() => {
    if (!key) return
    return onTranscriptCreate((outcome) => {
      changeLocalHistory(key, (records) => recordSaveOutcome(records, outcome, new Date()))
    })
  }, [key])
}
