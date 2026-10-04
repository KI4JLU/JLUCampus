import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
  type MutationState,
  type QueryClient
} from '@tanstack/react-query'
import type { TranscriptionSummary, TranscriptionSummaryRequest } from '@justcampus/shared'
import { ApiRequestError } from '@/lib/api'
import { generateSummary, transcriptionKeys } from '../api'

/**
 * A transcript's summary by template (T-48, T-49). The stored one is looked up with `checkOnly`
 * when the summary is shown; "generate" asks without `forceRegenerate`, "regenerate" with it. All
 * of it is keyed by transcript, revision, template and template version, so an answer never shows
 * for another transcript, an edited one, another template or an older version of the template,
 * even when it arrives after a switch or an edit. The model and its settings are the server's
 * choice; its store is keyed by them too, and a lookup after a reload asks it again.
 */

/** Below `['transcription']`, which a catalogue change invalidates as a whole. */
export const summaryKey = (
  transcriptId: string,
  revision: number,
  templateId: string,
  templateVersion: number
): readonly ['transcription', 'summary', string, number, string, number] =>
  ['transcription', 'summary', transcriptId, revision, templateId, templateVersion] as const
type SummaryKey = ReturnType<typeof summaryKey>

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
  templateId: string
  /** The version of the template the user sees; an edit raises it. */
  templateVersion: number
}

/**
 * Where a generated summary belongs: under the template version and revision it was made from,
 * which can be newer than the one asked for when the template changed meanwhile. `null`: it was
 * made from text, not the saved transcript, so it belongs nowhere.
 */
export function summaryKeyOf(
  transcriptId: string,
  summary: TranscriptionSummary
): SummaryKey | null {
  if (summary.transcriptRevision === null) return null
  return summaryKey(
    transcriptId,
    summary.transcriptRevision,
    summary.templateId,
    summary.templateVersion
  )
}

interface Variables {
  key: SummaryKey
  input: TranscriptionSummaryRequest
}

export function useSummary(target: SummaryTarget | null, enabled = true): SummaryState {
  const client = useQueryClient()
  const key = target
    ? summaryKey(target.transcriptId, target.revision, target.templateId, target.templateVersion)
    : null

  const stored = useQuery({
    queryKey: key ?? ['transcription', 'summary', 'none'],
    queryFn: async ({ signal }) => {
      const { summary } = await generateSummary(
        { transcriptId: target!.transcriptId, templateId: target!.templateId, checkOnly: true },
        signal
      )
      // One stored for another version or revision is not this one's.
      return summary && fileSummary(client, target!.transcriptId, summary, key!) ? summary : null
    },
    enabled: enabled && key !== null,
    // kiChat shows the empty state when the lookup fails, and so does the summary here.
    retry: false,
    staleTime: Infinity,
    networkMode: 'always'
  })

  const generation = useMutation({
    mutationKey: key ?? ['transcription', 'summary', 'none'],
    networkMode: 'always',
    mutationFn: ({ input }: Variables) => generateSummary(input),
    onSuccess: ({ summary }, { key: requested, input }) => {
      if (
        summary &&
        input.transcriptId &&
        fileSummary(client, input.transcriptId, summary, requested)
      ) {
        client.setQueryData(requested, summary)
      }
    }
  })
  const { mutate } = generation

  const runs = useMutationState<MutationState<unknown, Error, Variables>>({
    filters: { mutationKey: key ?? ['transcription', 'summary', 'none'], exact: true },
    select: (mutation) => mutation.state as MutationState<unknown, Error, Variables>
  })
  const last = runs.at(-1)

  const generate = (force: boolean): void => {
    if (!target || !key) return
    mutate({
      key,
      input: {
        transcriptId: target.transcriptId,
        templateId: target.templateId,
        forceRegenerate: force
      }
    })
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

/**
 * Whether a summary belongs under `requested`. One made from another template version or revision
 * is filed under its own key instead, and the template and transcript are fetched again, so a
 * newer one moves the view there; a late answer for an older one stays under the older key.
 */
export function fileSummary(
  client: QueryClient,
  transcriptId: string,
  summary: TranscriptionSummary,
  requested: SummaryKey
): boolean {
  const made = summaryKeyOf(transcriptId, summary)
  if (!made) return false
  if (sameKey(made, requested)) return true
  client.setQueryData(made, summary)
  void client.invalidateQueries({ queryKey: transcriptionKeys.templates })
  void client.invalidateQueries({ queryKey: transcriptionKeys.transcript(transcriptId) })
  return false
}

function sameKey(a: SummaryKey | null, b: SummaryKey): boolean {
  return a !== null && a.every((part, index) => part === b[index])
}

/** The texts of a failed generation. */
export interface SummaryErrorTexts {
  /** `Generierung fehlgeschlagen: ` before the server's reason. */
  prefix: string
  /** The server gave no reason. */
  serverError: string
  /** No answer at all. */
  communicationError: string
}

/** Why a generation failed, as kiChat words it: the server's reason, else a connection error. */
export function summaryErrorMessage(error: unknown, texts: SummaryErrorTexts): string {
  if (error instanceof ApiRequestError) {
    const reason = error.body?.error.message
    return reason ? `${texts.prefix}${reason}` : texts.serverError
  }
  return texts.communicationError
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
