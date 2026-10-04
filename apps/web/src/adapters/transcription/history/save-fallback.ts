import { useEffect, useEffectEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import type {
  TranscriptionTranscript,
  TranscriptionTranscriptPatch,
  TranscriptionTranscriptSummary
} from '@justcampus/shared'
import { toast } from '@/lib/toast'
import {
  getTranscript,
  onTranscriptCreate,
  patchTranscript,
  transcriptionKeys,
  type TranscriptCreateOutcome
} from '../api'
import {
  changeLocalHistory,
  recordSaveOutcome,
  settleTitleMerge,
  type SaveReconciliation,
  type TitleMerge,
  type TitleMergeOutcome
} from './local-store'

export interface TitleMergeDeps {
  get: (id: string) => Promise<TranscriptionTranscript>
  patch: (id: string, patch: TranscriptionTranscriptPatch) => Promise<TranscriptionTranscript>
}

/** Merges already under way, so a second listener does not send the same title again. */
const running = new Set<string>()

/**
 * Carries the title of a renamed local copy to the server transcript that now holds its content,
 * then settles the copy: gone when the title arrived and the copy did not change meanwhile, else
 * kept as a copy of its own. `saved` is the server's transcript after the change, if it took it.
 */
export async function carryLocalTitle(
  key: string,
  merge: TitleMerge,
  deps: TitleMergeDeps
): Promise<{ outcome: TitleMergeOutcome; saved: TranscriptionTranscript | null }> {
  let saved: TranscriptionTranscript | null = null
  try {
    // The latest revision: the AI subtitle may have arrived since the save.
    const latest = await deps.get(merge.transcriptId)
    saved = await deps.patch(merge.transcriptId, {
      baseRevision: latest.revision,
      title: merge.title,
      ...(merge.subtitle ? { subtitle: merge.subtitle } : {})
    })
  } catch {
    saved = null
  }
  let outcome = 'gone' as TitleMergeOutcome
  const written = changeLocalHistory(key, (records) => {
    const settled = settleTitleMerge(records, merge, saved !== null)
    outcome = settled.outcome
    return settled.records
  })
  // Storage that refused the change still holds the copy: it stays, not merged.
  if (!written && outcome === 'merged') outcome = 'kept'
  return { outcome, saved }
}

/**
 * Keeps a transcript whose save did not reach the server in the signed-in user's local history of
 * the module (T-39, kiChat's `saveProcessedFile`): it is listed as "only on this device" and opens
 * after a reload. Once a save of the same jobs reached the server, also with another idempotency
 * key after a reload, an unchanged copy goes again and `onReplaced` hears of it; a copy the user
 * renamed gets its title carried to the server first, and one with other edits stays, with a
 * notice either way. When the browser does not take the copy either, the user is told. `key` is
 * the history's storage key, `null` while the user is not known.
 */
export function useLocalSaveFallback(
  key: string | null,
  onReplaced: (localId: string, transcriptId: string) => void
): void {
  const { t } = useTranslation()
  const client = useQueryClient()

  const showSaved = (saved: TranscriptionTranscript): void => {
    client.setQueryData(transcriptionKeys.transcript(saved.id), saved)
    client.setQueryData<TranscriptionTranscriptSummary[]>(transcriptionKeys.transcripts, (list) =>
      list?.map((entry) =>
        entry.id === saved.id
          ? { ...entry, title: saved.title, subtitle: saved.subtitle, updatedAt: saved.updatedAt }
          : entry
      )
    )
  }
  const keptNotice = (): void => {
    toast({ variant: 'info', title: t('transcription.result.localCopyKept') })
  }

  const settledMerge = useEffectEvent(
    (merge: TitleMerge, settled: TitleMergeOutcome, saved: TranscriptionTranscript | null) => {
      if (saved) showSaved(saved)
      if (settled === 'merged') {
        onReplaced(merge.localId, merge.transcriptId)
        toast({ variant: 'success', title: t('transcription.result.localTitleCarried') })
      } else if (settled === 'kept') keptNotice()
    }
  )

  const handle = useEffectEvent((key: string, outcome: TranscriptCreateOutcome): void => {
    let result: SaveReconciliation | null = null
    let adds = false
    const written = changeLocalHistory(key, (records) => {
      const next = recordSaveOutcome(records, outcome, new Date())
      result = next
      adds = next.records.some((record) => !records.includes(record))
      return next.records
    })
    if (!written) {
      // The history stays as it was; a save that also missed the server is in neither place.
      if ('error' in outcome && adds) {
        toast({ variant: 'error', title: t('transcription.result.localFallbackFailed') })
      }
      return
    }
    if (!result) return
    const { replaced, merges, kept } = result as SaveReconciliation
    for (const { localId, transcriptId } of replaced) onReplaced(localId, transcriptId)
    if (kept.length > 0) keptNotice()
    for (const merge of merges) {
      if (running.has(merge.localId)) continue
      running.add(merge.localId)
      void carryLocalTitle(key, merge, { get: getTranscript, patch: patchTranscript })
        .then(({ outcome: settled, saved }) => settledMerge(merge, settled, saved))
        .finally(() => running.delete(merge.localId))
    }
  })

  useEffect(() => {
    if (!key) return
    return onTranscriptCreate((outcome) => handle(key, outcome))
  }, [key])
}
