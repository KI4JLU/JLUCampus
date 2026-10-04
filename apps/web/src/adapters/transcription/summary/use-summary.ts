import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
  type MutationState
} from '@tanstack/react-query'
import type { TranscriptionSummary, TranscriptionSummaryRequest } from '@justcampus/shared'
import { ApiRequestError } from '@/lib/api'
import { generateSummary } from '../api'

/**
 * A transcript's summary by template (T-48, T-49). The stored one is looked up with `checkOnly`
 * when the summary is shown; "generate" asks without `forceRegenerate`, "regenerate" with it. All
 * of it is keyed by transcript, revision and template, so an answer never shows for another
 * transcript, an edited one or another template, even when it arrives after a switch.
 */

/** Below `['transcription']`, which a catalogue change invalidates as a whole. */
export const summaryKey = (
  transcriptId: string,
  revision: number,
  templateId: string
): readonly ['transcription', 'summary', string, number, string] =>
  ['transcription', 'summary', transcriptId, revision, templateId] as const
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
}

interface Variables {
  key: SummaryKey
  input: TranscriptionSummaryRequest
}

export function useSummary(target: SummaryTarget | null, enabled = true): SummaryState {
  const client = useQueryClient()
  const key = target ? summaryKey(target.transcriptId, target.revision, target.templateId) : null

  const stored = useQuery({
    queryKey: key ?? ['transcription', 'summary', 'none'],
    queryFn: async ({ signal }) =>
      (
        await generateSummary(
          { transcriptId: target!.transcriptId, templateId: target!.templateId, checkOnly: true },
          signal
        )
      ).summary,
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
    onSuccess: (response, { key: requested }) => client.setQueryData(requested, response.summary)
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
