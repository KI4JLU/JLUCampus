import { useMemo } from 'react'
import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
  type MutationState,
  type QueryClient
} from '@tanstack/react-query'
import type { TranscriptionSummary, TranscriptionSummaryRequest } from '@justcampus/shared'
import { generateSummary, transcriptionKeys } from '../api'
import { textFingerprint } from './source'

/**
 * A transcript's summary by template (T-48, T-49). The stored one is looked up with `checkOnly`
 * when the summary is shown; "generate" asks without `forceRegenerate`, "regenerate" with it. A
 * transcript only this browser has sends its text instead of its id (`source.ts`); the server
 * stores nothing for it, so only what was generated here shows.
 *
 * Section 5 caches summaries by transcript revision, template version, model and settings, and
 * so does the browser: the key holds the transcript and its revision (for a local one the
 * fingerprint of the text sent), the saved transcript's title, the template and its version, and
 * the summary model the module uses (`capabilities.defaultSummaryModel`). The settings are the
 * template's structure, which its version covers, and the transcript's facts for the
 * placeholders: date, participants and duration come with the revision, but a generated title
 * replaces the default one without a new revision, so the title is a part of its own. An answer
 * never shows for another transcript, an edited one, another title, another template, an older
 * version of it or another model, even when it arrives after a switch, an edit or an admin's
 * change of the model: it is filed under what it was made from (`fileSummary`).
 */

/** What a summary is made of in its key: a saved transcript's revision, or `text:<fingerprint>`. */
export type SummarySourceKey = number | string

/** Below `transcriptionKeys.all`; `title` is `null` for text. */
export const summaryKey = (
  transcriptId: string,
  source: SummarySourceKey,
  title: string | null,
  templateId: string,
  templateVersion: number,
  model: string | null
): readonly [
  'transcription',
  'summary',
  string,
  SummarySourceKey,
  string | null,
  string,
  number,
  string | null
] =>
  [
    'transcription',
    'summary',
    transcriptId,
    source,
    title,
    templateId,
    templateVersion,
    model
  ] as const
type SummaryKey = ReturnType<typeof summaryKey>

const NO_KEY = ['transcription', 'summary', 'none'] as const

export type SummaryStatus = 'idle' | 'checking' | 'empty' | 'loading' | 'ready' | 'error'

export interface SummaryState {
  status: SummaryStatus
  summary: TranscriptionSummary | null
  /** Why the last generation failed. */
  error: unknown
  /** Generates the summary; `force` makes a new one even if one is stored. */
  generate: (force: boolean) => void
}

export interface SummaryTarget {
  transcriptId: string
  revision: number
  /**
   * The title the server holds for a saved transcript, which it fills `{{title}}` with; `null`
   * for text.
   */
  title: string | null
  /**
   * The text of a transcript only this browser has, redactions applied, sent instead of its id;
   * `null` for a saved one.
   */
  text: string | null
  templateId: string
  /** The version of the template the user sees; an edit raises it. */
  templateVersion: number
  /** The summary model the module uses now; the answer names the one the server used. */
  model: string | null
}

/** The source part of a target's key: its revision, or its text's fingerprint. */
export function sourceKey(target: Pick<SummaryTarget, 'revision' | 'text'>): SummarySourceKey {
  return target.text === null ? target.revision : `text:${textFingerprint(target.text)}`
}

/**
 * Where a generated summary belongs: under the revision, title, template version and model it
 * was made from, which can differ from the ones asked for when the transcript, its title, the
 * template or the module's model changed meanwhile. One made from text belongs to the text that
 * was sent.
 */
export function summaryKeyOf(requested: SummaryKey, summary: TranscriptionSummary): SummaryKey {
  const revision = summary.transcriptRevision
  return summaryKey(
    requested[2],
    revision ?? requested[3],
    revision === null ? requested[4] : summary.transcriptTitle,
    summary.templateId,
    summary.templateVersion,
    summary.model
  )
}

interface Variables {
  key: SummaryKey
  input: TranscriptionSummaryRequest
}

export function useSummary(target: SummaryTarget | null, enabled = true): SummaryState {
  const client = useQueryClient()
  const text = target?.text ?? null
  const revision = target?.revision ?? 0
  // A local transcript's text can be long; it is fingerprinted when it changes, not each render.
  const source = useMemo(() => sourceKey({ revision, text }), [revision, text])
  const key = target
    ? summaryKey(
        target.transcriptId,
        source,
        target.text === null ? target.title : null,
        target.templateId,
        target.templateVersion,
        target.model
      )
    : null

  const stored = useQuery({
    queryKey: key ?? NO_KEY,
    queryFn: async ({ signal }) => {
      const { summary } = await generateSummary(
        { transcriptId: target!.transcriptId, templateId: target!.templateId, checkOnly: true },
        signal
      )
      // One stored for another version, revision, title or model is not this one's.
      return summary && fileSummary(client, summary, key!) ? summary : null
    },
    // Nothing is stored for text; only a summary generated here shows.
    enabled: enabled && key !== null && text === null,
    // kiChat shows the empty state when the lookup fails, and so does the summary here.
    retry: false,
    staleTime: Infinity,
    networkMode: 'always'
  })

  const generation = useMutation({
    mutationKey: key ?? NO_KEY,
    networkMode: 'always',
    mutationFn: ({ input }: Variables) => generateSummary(input),
    onSuccess: ({ summary }, { key: requested }) => {
      if (summary && fileSummary(client, summary, requested)) {
        client.setQueryData(requested, summary)
      }
    }
  })
  const { mutate } = generation

  const runs = useMutationState<MutationState<unknown, Error, Variables>>({
    filters: { mutationKey: key ?? NO_KEY, exact: true },
    select: (mutation) => mutation.state as MutationState<unknown, Error, Variables>
  })
  const last = runs.at(-1)

  const generate = (force: boolean): void => {
    if (!target || !key) return
    mutate({ key, input: summaryRequest(target, force) })
  }

  let status: SummaryStatus
  if (!key) status = 'idle'
  else if (last?.status === 'pending') status = 'loading'
  else if (last?.status === 'error') status = 'error'
  else if (stored.data) status = 'ready'
  else if (stored.isPending && stored.fetchStatus !== 'idle') status = 'checking'
  else status = 'empty'

  return {
    status,
    summary: status === 'ready' ? (stored.data ?? null) : null,
    error: status === 'error' ? last?.error : null,
    generate
  }
}

/** The request that generates a target's summary: by id, or by text for a local transcript. */
export function summaryRequest(target: SummaryTarget, force: boolean): TranscriptionSummaryRequest {
  return target.text === null
    ? { transcriptId: target.transcriptId, templateId: target.templateId, forceRegenerate: force }
    : { transcriptText: target.text, templateId: target.templateId, forceRegenerate: force }
}

/**
 * Whether a summary belongs under `requested`. One made from another template version, revision,
 * title or model is filed under its own key instead, and whatever named the outdated part is
 * fetched again (template list, transcript, capabilities), so a newer one moves the view there; a
 * late answer for an older one stays under the older key.
 */
export function fileSummary(
  client: QueryClient,
  summary: TranscriptionSummary,
  requested: SummaryKey
): boolean {
  const made = summaryKeyOf(requested, summary)
  if (sameKey(made, requested)) return true
  client.setQueryData(made, summary)
  if (made[5] !== requested[5] || made[6] !== requested[6]) {
    void client.invalidateQueries({ queryKey: transcriptionKeys.templates })
  }
  if (made[3] !== requested[3] || made[4] !== requested[4]) {
    void client.invalidateQueries({ queryKey: transcriptionKeys.transcript(requested[2]) })
  }
  if (made[7] !== requested[7]) {
    void client.invalidateQueries({ queryKey: transcriptionKeys.capabilities })
  }
  return false
}

function sameKey(a: SummaryKey, b: SummaryKey): boolean {
  return a.every((part, index) => part === b[index])
}

/** The skeleton's labels: the template's section headings, else kiChat's three. */
export function skeletonHeadlines(subtext: string, fallback: string): string[] {
  const split = (text: string): string[] =>
    text
      .split('·')
      .map((headline) => headline.trim())
      .filter(Boolean)
  const headlines = split(subtext)
  return headlines.length > 0 ? headlines : split(fallback)
}
