import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
  type UseQueryOptions,
  type UseQueryResult
} from '@tanstack/react-query'
import {
  isActiveJobStatus,
  TRANSCRIPTION_API,
  TRANSCRIPTION_MEDIA_URL_REFRESH_SECONDS,
  TRANSCRIPTION_POLL_MS,
  transcriptionCapabilitiesSchema,
  transcriptionConnectionTestSchema,
  transcriptionFormatListSchema,
  transcriptionFormatSchema,
  transcriptionJobCreatedSchema,
  transcriptionJobListSchema,
  transcriptionJobPeaksSchema,
  transcriptionJobSchema,
  transcriptionMediaUrlSchema,
  transcriptionModelListSchema,
  transcriptionRealtimeConfigSchema,
  transcriptionSpeakerOptimizationSchema,
  transcriptionSummaryPreviewSchema,
  transcriptionSummaryResponseSchema,
  transcriptionTemplateListSchema,
  transcriptionTemplateSchema,
  transcriptionTranscriptListSchema,
  transcriptionTranscriptSchema,
  type TranscriptionAnalyze,
  type TranscriptionCapabilities,
  type TranscriptionConnectionTest,
  type TranscriptionConnectionTestRequest,
  type TranscriptionDispatch,
  type TranscriptionFormat,
  type TranscriptionFormatInput,
  type TranscriptionJob,
  type TranscriptionJobCreate,
  type TranscriptionJobCreated,
  type TranscriptionJobPeaks,
  type TranscriptionMediaUrl,
  type TranscriptionModelList,
  type TranscriptionModelsRequest,
  type TranscriptionRealtimeConfig,
  type TranscriptionRealtimeMode,
  type TranscriptionSpeakerOptimization,
  type TranscriptionSpeakerOptimizationRequest,
  type TranscriptionSummaryPreview,
  type TranscriptionSummaryPreviewRequest,
  type TranscriptionSummaryRequest,
  type TranscriptionSummaryResponse,
  type TranscriptionTemplate,
  type TranscriptionTemplateInput,
  type TranscriptionTranscript,
  type TranscriptionTranscriptCreate,
  type TranscriptionTranscriptPatch,
  type TranscriptionTranscriptSummary,
  type TranscriptionUploadTarget
} from '@justcampus/shared'
import { ApiRequestError, apiBase, apiFetch } from '@/lib/api'
import { withParsedSegments } from './segments/payload'

/**
 * Every endpoint of the transcription module as a typed function, plus TanStack Query keys and
 * hooks. Answers are checked against the contract like the translator's. Requests go out even when
 * the browser says it is offline and fail at once then: a request held back would look like one on
 * its way.
 */

const NETWORK_MODE = 'always' as const

/** An answer from the server (a disabled module, a refused request) is not retried. */
const retry = (count: number, error: Error): boolean =>
  !(error instanceof ApiRequestError) && count < 2

/** Query keys, all below `['transcription']`, which a catalogue change invalidates as a whole. */
export const transcriptionKeys = {
  all: ['transcription'] as const,
  capabilities: ['transcription', 'capabilities'] as const,
  jobs: ['transcription', 'jobs'] as const,
  job: (id: string) => ['transcription', 'job', id] as const,
  jobAudio: (id: string) => ['transcription', 'job', id, 'audio'] as const,
  jobSample: (id: string, sampleId: string) =>
    ['transcription', 'job', id, 'sample', sampleId] as const,
  transcripts: ['transcription', 'transcripts'] as const,
  transcript: (id: string) => ['transcription', 'transcript', id] as const,
  formats: ['transcription', 'formats'] as const,
  templates: ['transcription', 'templates'] as const,
  realtimeConfig: ['transcription', 'realtime-config'] as const
}

// ---------------------------------------------------------------------------
// Fetch functions
// ---------------------------------------------------------------------------

const post = { method: 'POST' } as const

export async function fetchCapabilities(signal?: AbortSignal): Promise<TranscriptionCapabilities> {
  return transcriptionCapabilitiesSchema.parse(
    await apiFetch<unknown>(TRANSCRIPTION_API.capabilities, { signal })
  )
}

/** The user's jobs that are not saved, deleted or expired (T-15). */
export async function listJobs(signal?: AbortSignal): Promise<TranscriptionJob[]> {
  return transcriptionJobListSchema.parse(
    await apiFetch<unknown>(TRANSCRIPTION_API.jobs, { signal })
  ).jobs
}

/** A new job and where its bytes go (T-10). */
export async function createJob(input: TranscriptionJobCreate): Promise<TranscriptionJobCreated> {
  return transcriptionJobCreatedSchema.parse(
    await apiFetch<unknown>(TRANSCRIPTION_API.jobs, { ...post, json: input })
  )
}

export async function getJob(id: string, signal?: AbortSignal): Promise<TranscriptionJob> {
  return transcriptionJobSchema.parse(
    await apiFetch<unknown>(TRANSCRIPTION_API.job(id), { signal })
  )
}

/** Cancels the job and deletes its audio; deleting it again succeeds too. */
export async function deleteJob(id: string): Promise<void> {
  await apiFetch<void>(TRANSCRIPTION_API.job(id), { method: 'DELETE' })
}

/** Confirms the upload and (re)starts the speaker analysis (T-10, T-21). */
export async function analyzeJob(
  id: string,
  input: TranscriptionAnalyze = {}
): Promise<TranscriptionJob> {
  return transcriptionJobSchema.parse(
    await apiFetch<unknown>(TRANSCRIPTION_API.jobAnalyze(id), { ...post, json: input })
  )
}

/** Starts the transcription with names, voice windows and settings (T-13, T-18). */
export async function dispatchJob(
  id: string,
  input: TranscriptionDispatch
): Promise<TranscriptionJob> {
  return transcriptionJobSchema.parse(
    await apiFetch<unknown>(TRANSCRIPTION_API.jobDispatch(id), { ...post, json: input })
  )
}

/** A fresh URL of the job's audio (T-24). */
export async function getJobAudioUrl(
  id: string,
  signal?: AbortSignal
): Promise<TranscriptionMediaUrl> {
  return transcriptionMediaUrlSchema.parse(
    await apiFetch<unknown>(TRANSCRIPTION_API.jobAudio(id), { signal })
  )
}

/**
 * The waveform the analysis computed, for audio too large to decode here (T-12, T-19); `null`
 * before the analysis or without one.
 */
export async function getJobPeaks(
  id: string,
  signal?: AbortSignal
): Promise<TranscriptionJobPeaks | null> {
  try {
    return transcriptionJobPeaksSchema.parse(
      await apiFetch<unknown>(TRANSCRIPTION_API.jobPeaks(id), { signal })
    )
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) return null
    throw error
  }
}

/** A fresh URL of one analysed voice sample (T-17, T-21). */
export async function getJobSampleUrl(
  id: string,
  sampleId: string,
  signal?: AbortSignal
): Promise<TranscriptionMediaUrl> {
  return transcriptionMediaUrlSchema.parse(
    await apiFetch<unknown>(TRANSCRIPTION_API.jobSample(id, sampleId), { signal })
  )
}

/** The user's history, newest change first (T-37). */
export async function listTranscripts(
  signal?: AbortSignal
): Promise<TranscriptionTranscriptSummary[]> {
  return transcriptionTranscriptListSchema.parse(
    await apiFetch<unknown>(TRANSCRIPTION_API.transcripts, { signal })
  ).transcripts
}

/** What became of a save of a new transcript: the saved one, or the error (T-39). */
export type TranscriptCreateOutcome =
  | { input: TranscriptionTranscriptCreate; transcript: TranscriptionTranscript }
  | { input: TranscriptionTranscriptCreate; error: unknown }

const createListeners = new Set<(outcome: TranscriptCreateOutcome) => void>()

/**
 * Hears of every save of a new transcript, wherever it starts; the history keeps one that failed
 * in this browser and drops that copy once a retry reached the server (T-39).
 */
export function onTranscriptCreate(
  listener: (outcome: TranscriptCreateOutcome) => void
): () => void {
  createListeners.add(listener)
  return () => {
    createListeners.delete(listener)
  }
}

/** Saves a group's merged result once; the same idempotency key answers the first save (T-13). */
export async function createTranscript(
  input: TranscriptionTranscriptCreate
): Promise<TranscriptionTranscript> {
  let transcript: TranscriptionTranscript
  try {
    transcript = transcriptionTranscriptSchema.parse(
      await apiFetch<unknown>(TRANSCRIPTION_API.transcripts, { ...post, json: input })
    )
  } catch (error) {
    createListeners.forEach((listener) => listener({ input, error }))
    throw error
  }
  createListeners.forEach((listener) => listener({ input, transcript }))
  return transcript
}

/** A saved transcript; segments sent as the JSON text of their array are read too (T-39). */
export async function getTranscript(
  id: string,
  signal?: AbortSignal
): Promise<TranscriptionTranscript> {
  return transcriptionTranscriptSchema.parse(
    withParsedSegments(await apiFetch<unknown>(TRANSCRIPTION_API.transcript(id), { signal }))
  )
}

/** Changes title, subtitle, segments or colours; another revision answers `409 conflict` (T-35). */
export async function patchTranscript(
  id: string,
  patch: TranscriptionTranscriptPatch
): Promise<TranscriptionTranscript> {
  return transcriptionTranscriptSchema.parse(
    await apiFetch<unknown>(TRANSCRIPTION_API.transcript(id), { method: 'PATCH', json: patch })
  )
}

export async function deleteTranscript(id: string): Promise<void> {
  await apiFetch<void>(TRANSCRIPTION_API.transcript(id), { method: 'DELETE' })
}

/** Has the chat model write a new subtitle (T-23). */
export async function generateSubtitle(id: string): Promise<TranscriptionTranscript> {
  return transcriptionTranscriptSchema.parse(
    await apiFetch<unknown>(TRANSCRIPTION_API.transcriptSubtitle(id), post)
  )
}

export async function listFormats(signal?: AbortSignal): Promise<TranscriptionFormat[]> {
  return transcriptionFormatListSchema.parse(
    await apiFetch<unknown>(TRANSCRIPTION_API.formats, { signal })
  ).formats
}

/** Creates (`id` null) or changes one of the user's formats (T-45). */
export async function saveFormat(input: TranscriptionFormatInput): Promise<TranscriptionFormat> {
  return transcriptionFormatSchema.parse(
    await apiFetch<unknown>(TRANSCRIPTION_API.formats, { ...post, json: input })
  )
}

export async function deleteFormat(id: string): Promise<void> {
  await apiFetch<void>(TRANSCRIPTION_API.format(id), { method: 'DELETE' })
}

/** The built-in templates, then the user's own (T-50). */
export async function listTemplates(signal?: AbortSignal): Promise<TranscriptionTemplate[]> {
  return transcriptionTemplateListSchema.parse(
    await apiFetch<unknown>(TRANSCRIPTION_API.templates, { signal })
  ).templates
}

/** Creates (`id` null) or changes one of the user's templates (T-51, T-54). */
export async function saveTemplate(
  input: TranscriptionTemplateInput
): Promise<TranscriptionTemplate> {
  return transcriptionTemplateSchema.parse(
    await apiFetch<unknown>(TRANSCRIPTION_API.templates, { ...post, json: input })
  )
}

export async function deleteTemplate(id: string): Promise<void> {
  await apiFetch<void>(TRANSCRIPTION_API.template(id), { method: 'DELETE' })
}

/** Generates, regenerates or looks up a summary (T-48, T-49). */
export async function generateSummary(
  input: TranscriptionSummaryRequest,
  signal?: AbortSignal
): Promise<TranscriptionSummaryResponse> {
  return transcriptionSummaryResponseSchema.parse(
    await apiFetch<unknown>(TRANSCRIPTION_API.summaries, { ...post, json: input, signal })
  )
}

/** Generates only the AI sections sent, for the template editor (T-53). */
export async function previewSummary(
  input: TranscriptionSummaryPreviewRequest,
  signal?: AbortSignal
): Promise<TranscriptionSummaryPreview> {
  return transcriptionSummaryPreviewSchema.parse(
    await apiFetch<unknown>(TRANSCRIPTION_API.summaryPreview, { ...post, json: input, signal })
  )
}

/** Has the chat model reassign speakers (T-36). */
export async function optimizeSpeakers(
  input: TranscriptionSpeakerOptimizationRequest,
  signal?: AbortSignal
): Promise<TranscriptionSpeakerOptimization> {
  return transcriptionSpeakerOptimizationSchema.parse(
    await apiFetch<unknown>(TRANSCRIPTION_API.speakerOptimization, { ...post, json: input, signal })
  )
}

/** The live modes that are set up (T-59). */
export async function getRealtimeConfig(
  signal?: AbortSignal
): Promise<TranscriptionRealtimeConfig> {
  return transcriptionRealtimeConfigSchema.parse(
    await apiFetch<unknown>(TRANSCRIPTION_API.realtimeConfig, { signal })
  )
}

/**
 * The live WebSocket for a mode (T-60): the API origin with `ws:`/`wss:`, the page's own when the
 * API has none. The browser sends the session cookie with the upgrade.
 */
export function liveSocketUrl(
  mode: TranscriptionRealtimeMode,
  base: string = apiBase(),
  page: string = window.location.href
): string {
  const url = new URL(`${base}${TRANSCRIPTION_API.realtimeLive}`, page)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('mode', mode)
  return url.toString()
}

/** Admin only: the models of a speech or chat endpoint, for the admin form. */
export async function fetchAdminModels(
  input: TranscriptionModelsRequest
): Promise<TranscriptionModelList> {
  return transcriptionModelListSchema.parse(
    await apiFetch<unknown>(TRANSCRIPTION_API.adminModels, { ...post, json: input })
  )
}

/** Admin only: checks one upstream with the values in the form. */
export async function testAdminConnection(
  input: TranscriptionConnectionTestRequest
): Promise<TranscriptionConnectionTest> {
  return transcriptionConnectionTestSchema.parse(
    await apiFetch<unknown>(TRANSCRIPTION_API.adminTest, { ...post, json: input })
  )
}

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

/**
 * Why an upload failed, as kiChat tells them apart (T-16): the server answered with an error
 * status, the network failed, or the upload was cancelled.
 */
export class UploadError extends Error {
  constructor(
    readonly kind: 'status' | 'network' | 'aborted',
    readonly status: number | null = null
  ) {
    super(kind === 'status' ? `Upload failed with status ${status}` : `Upload ${kind}`)
    this.name = 'UploadError'
  }
}

/**
 * Uploads `body` with the job's `PUT` to the API, which streams it into storage, reporting progress
 * from 0 to 1. `XMLHttpRequest` because `fetch` reports no upload progress. The session cookie
 * goes along also when the API is on another origin (desktop app, development). Recordings and
 * uploads both use it.
 */
export function uploadToTarget(
  target: TranscriptionUploadTarget,
  body: Blob,
  options: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new UploadError('aborted'))
      return
    }
    const request = new XMLHttpRequest()
    const abort = (): void => request.abort()
    request.open(target.method, target.url)
    request.withCredentials = true
    for (const [name, value] of Object.entries(target.headers))
      request.setRequestHeader(name, value)
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0)
        options.onProgress?.(event.loaded / event.total)
    }
    request.onload = () => {
      options.signal?.removeEventListener('abort', abort)
      if (request.status >= 200 && request.status < 300) {
        options.onProgress?.(1)
        resolve()
      } else reject(new UploadError('status', request.status))
    }
    request.onerror = () => {
      options.signal?.removeEventListener('abort', abort)
      reject(new UploadError('network'))
    }
    request.onabort = () => {
      options.signal?.removeEventListener('abort', abort)
      reject(new UploadError('aborted'))
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    request.send(body)
  })
}

/** Whether a media URL expires within `TRANSCRIPTION_MEDIA_URL_REFRESH_SECONDS` (T-21). */
export function mediaUrlExpiresSoon(
  media: TranscriptionMediaUrl,
  now: number = Date.now()
): boolean {
  return Date.parse(media.expiresAt) - now <= TRANSCRIPTION_MEDIA_URL_REFRESH_SECONDS * 1000
}

/** How long a media URL may be used before it is fetched anew, in milliseconds. */
function mediaStaleTime(media: TranscriptionMediaUrl | undefined): number {
  if (!media) return 0
  return Math.max(
    0,
    Date.parse(media.expiresAt) - Date.now() - TRANSCRIPTION_MEDIA_URL_REFRESH_SECONDS * 1000
  )
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const capabilitiesQuery = queryOptions({
  queryKey: transcriptionKeys.capabilities,
  queryFn: ({ signal }) => fetchCapabilities(signal),
  retry
})

/** What the module offers; it changes only when an admin saves the module. */
export function useTranscriptionCapabilities(): UseQueryResult<TranscriptionCapabilities> {
  return useQuery(capabilitiesQuery)
}

/** The user's active jobs, for restoring the queue after a reload (T-15). */
export function useTranscriptionJobs(enabled = true): UseQueryResult<TranscriptionJob[]> {
  return useQuery({
    queryKey: transcriptionKeys.jobs,
    queryFn: ({ signal }) => listJobs(signal),
    enabled,
    retry,
    networkMode: NETWORK_MODE
  })
}

/**
 * One job, fetched again every `pollMs` while the server works on it (analysis or
 * transcription) and no longer once it ended or waits for the user.
 */
export function useTranscriptionJob(
  id: string | null,
  options: { pollMs?: number; enabled?: boolean } = {}
): UseQueryResult<TranscriptionJob> {
  const pollMs = options.pollMs ?? TRANSCRIPTION_POLL_MS
  return useQuery({
    queryKey: transcriptionKeys.job(id ?? ''),
    queryFn: ({ signal }) => getJob(id!, signal),
    enabled: id !== null && (options.enabled ?? true),
    retry,
    networkMode: NETWORK_MODE,
    refetchInterval: (query) =>
      query.state.data && isActiveJobStatus(query.state.data.status) ? pollMs : false
  })
}

/**
 * The audio URL of a job (T-24). It goes stale shortly before it expires, so the next mount
 * or `refetch` gets a fresh one; it is not swapped on its own, which would interrupt playback.
 */
export function useJobAudioUrl(jobId: string | null): UseQueryResult<TranscriptionMediaUrl> {
  return useQuery({
    queryKey: transcriptionKeys.jobAudio(jobId ?? ''),
    queryFn: ({ signal }) => getJobAudioUrl(jobId!, signal),
    enabled: jobId !== null,
    retry,
    staleTime: (query) => mediaStaleTime(query.state.data)
  })
}

/** The URL of one voice sample, stale shortly before it expires (T-21). */
export function useJobSampleUrl(
  jobId: string | null,
  sampleId: string | null
): UseQueryResult<TranscriptionMediaUrl> {
  return useQuery({
    queryKey: transcriptionKeys.jobSample(jobId ?? '', sampleId ?? ''),
    queryFn: ({ signal }) => getJobSampleUrl(jobId!, sampleId!, signal),
    enabled: jobId !== null && sampleId !== null,
    retry,
    staleTime: (query) => mediaStaleTime(query.state.data)
  })
}

export function useTranscripts(): UseQueryResult<TranscriptionTranscriptSummary[]> {
  return useQuery({
    queryKey: transcriptionKeys.transcripts,
    queryFn: ({ signal }) => listTranscripts(signal),
    retry,
    networkMode: NETWORK_MODE
  })
}

/** The detail of a saved transcript, as the result view loads it. */
export function transcriptQuery(
  id: string
): UseQueryOptions<
  TranscriptionTranscript,
  Error,
  TranscriptionTranscript,
  ReturnType<typeof transcriptionKeys.transcript>
> {
  return queryOptions({
    queryKey: transcriptionKeys.transcript(id),
    queryFn: ({ signal }) => getTranscript(id, signal),
    retry,
    networkMode: NETWORK_MODE,
    // The workspace holds the edits; a refetch must not overwrite them behind its back. Opening a
    // transcript loads it afresh all the same, so changes from elsewhere show (T-39).
    staleTime: Infinity,
    refetchOnMount: 'always'
  })
}

export function useTranscript(id: string | null): UseQueryResult<TranscriptionTranscript> {
  return useQuery({ ...transcriptQuery(id ?? ''), enabled: id !== null })
}

export function useTranscriptionFormats(): UseQueryResult<TranscriptionFormat[]> {
  return useQuery({
    queryKey: transcriptionKeys.formats,
    queryFn: ({ signal }) => listFormats(signal),
    retry
  })
}

export function useTranscriptionTemplates(): UseQueryResult<TranscriptionTemplate[]> {
  return useQuery({
    queryKey: transcriptionKeys.templates,
    queryFn: ({ signal }) => listTemplates(signal),
    retry
  })
}

export function useRealtimeConfig(enabled = true): UseQueryResult<TranscriptionRealtimeConfig> {
  return useQuery({
    queryKey: transcriptionKeys.realtimeConfig,
    queryFn: ({ signal }) => getRealtimeConfig(signal),
    enabled,
    retry
  })
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** Puts a job into the list and detail caches. */
function storeJob(client: QueryClient, job: TranscriptionJob): void {
  client.setQueryData(transcriptionKeys.job(job.id), job)
  client.setQueryData<TranscriptionJob[]>(transcriptionKeys.jobs, (jobs) =>
    jobs ? [...jobs.filter((other) => other.id !== job.id), job] : jobs
  )
}

/** Puts a transcript into the detail cache and refreshes the history. */
function storeTranscript(client: QueryClient, transcript: TranscriptionTranscript): void {
  client.setQueryData(transcriptionKeys.transcript(transcript.id), transcript)
  void client.invalidateQueries({ queryKey: transcriptionKeys.transcripts })
}

export function useCreateJob(): UseMutationResult<
  TranscriptionJobCreated,
  Error,
  TranscriptionJobCreate
> {
  const client = useQueryClient()
  return useMutation({
    networkMode: NETWORK_MODE,
    mutationFn: createJob,
    onSuccess: ({ job }) => storeJob(client, job)
  })
}

export function useDeleteJob(): UseMutationResult<void, Error, string> {
  const client = useQueryClient()
  return useMutation({
    networkMode: NETWORK_MODE,
    mutationFn: deleteJob,
    onSuccess: (_, id) => {
      client.removeQueries({ queryKey: transcriptionKeys.job(id) })
      client.setQueryData<TranscriptionJob[]>(transcriptionKeys.jobs, (jobs) =>
        jobs?.filter((job) => job.id !== id)
      )
    }
  })
}

export function useAnalyzeJob(): UseMutationResult<
  TranscriptionJob,
  Error,
  { id: string; input?: TranscriptionAnalyze }
> {
  const client = useQueryClient()
  return useMutation({
    networkMode: NETWORK_MODE,
    mutationFn: ({ id, input }) => analyzeJob(id, input),
    onSuccess: (job) => storeJob(client, job)
  })
}

export function useDispatchJob(): UseMutationResult<
  TranscriptionJob,
  Error,
  { id: string; input: TranscriptionDispatch }
> {
  const client = useQueryClient()
  return useMutation({
    networkMode: NETWORK_MODE,
    mutationFn: ({ id, input }) => dispatchJob(id, input),
    onSuccess: (job) => storeJob(client, job)
  })
}

export function useCreateTranscript(): UseMutationResult<
  TranscriptionTranscript,
  Error,
  TranscriptionTranscriptCreate
> {
  const client = useQueryClient()
  return useMutation({
    networkMode: NETWORK_MODE,
    mutationFn: createTranscript,
    onSuccess: (transcript) => {
      storeTranscript(client, transcript)
      // Saved jobs leave the active list.
      void client.invalidateQueries({ queryKey: transcriptionKeys.jobs })
    }
  })
}

export function usePatchTranscript(): UseMutationResult<
  TranscriptionTranscript,
  Error,
  { id: string; patch: TranscriptionTranscriptPatch }
> {
  const client = useQueryClient()
  return useMutation({
    networkMode: NETWORK_MODE,
    mutationFn: ({ id, patch }) => patchTranscript(id, patch),
    onSuccess: (transcript) => storeTranscript(client, transcript)
  })
}

/** Deletes a transcript; only a successful answer removes it from the history (T-40). */
export function useDeleteTranscript(): UseMutationResult<void, Error, string> {
  const client = useQueryClient()
  return useMutation({
    networkMode: NETWORK_MODE,
    mutationFn: deleteTranscript,
    onSuccess: (_, id) => {
      client.removeQueries({ queryKey: transcriptionKeys.transcript(id) })
      client.setQueryData<TranscriptionTranscriptSummary[]>(transcriptionKeys.transcripts, (list) =>
        list?.filter((entry) => entry.id !== id)
      )
    }
  })
}

export function useGenerateSubtitle(): UseMutationResult<TranscriptionTranscript, Error, string> {
  const client = useQueryClient()
  return useMutation({
    networkMode: NETWORK_MODE,
    mutationFn: generateSubtitle,
    onSuccess: (transcript) => storeTranscript(client, transcript)
  })
}

export function useSaveFormat(): UseMutationResult<
  TranscriptionFormat,
  Error,
  TranscriptionFormatInput
> {
  const client = useQueryClient()
  return useMutation({
    networkMode: NETWORK_MODE,
    mutationFn: saveFormat,
    onSuccess: () => client.invalidateQueries({ queryKey: transcriptionKeys.formats })
  })
}

export function useDeleteFormat(): UseMutationResult<void, Error, string> {
  const client = useQueryClient()
  return useMutation({
    networkMode: NETWORK_MODE,
    mutationFn: deleteFormat,
    onSuccess: () => client.invalidateQueries({ queryKey: transcriptionKeys.formats })
  })
}

export function useSaveTemplate(): UseMutationResult<
  TranscriptionTemplate,
  Error,
  TranscriptionTemplateInput
> {
  const client = useQueryClient()
  return useMutation({
    networkMode: NETWORK_MODE,
    mutationFn: saveTemplate,
    onSuccess: () => client.invalidateQueries({ queryKey: transcriptionKeys.templates })
  })
}

export function useDeleteTemplate(): UseMutationResult<void, Error, string> {
  const client = useQueryClient()
  return useMutation({
    networkMode: NETWORK_MODE,
    mutationFn: deleteTemplate,
    onSuccess: () => client.invalidateQueries({ queryKey: transcriptionKeys.templates })
  })
}

export function useGenerateSummary(): UseMutationResult<
  TranscriptionSummaryResponse,
  Error,
  TranscriptionSummaryRequest
> {
  return useMutation({
    networkMode: NETWORK_MODE,
    mutationFn: (input: TranscriptionSummaryRequest) => generateSummary(input)
  })
}

export function useSummaryPreview(): UseMutationResult<
  TranscriptionSummaryPreview,
  Error,
  TranscriptionSummaryPreviewRequest
> {
  return useMutation({
    networkMode: NETWORK_MODE,
    mutationFn: (input: TranscriptionSummaryPreviewRequest) => previewSummary(input)
  })
}

export function useOptimizeSpeakers(): UseMutationResult<
  TranscriptionSpeakerOptimization,
  Error,
  TranscriptionSpeakerOptimizationRequest
> {
  return useMutation({
    networkMode: NETWORK_MODE,
    mutationFn: (input: TranscriptionSpeakerOptimizationRequest) => optimizeSpeakers(input)
  })
}

/** The models of an endpoint, for the admin form. */
export function useFetchAdminModels(): UseMutationResult<
  TranscriptionModelList,
  Error,
  TranscriptionModelsRequest
> {
  return useMutation({ networkMode: NETWORK_MODE, mutationFn: fetchAdminModels })
}

/** Checks one upstream, for the admin form. */
export function useTestAdminConnection(): UseMutationResult<
  TranscriptionConnectionTest,
  Error,
  TranscriptionConnectionTestRequest
> {
  return useMutation({ networkMode: NETWORK_MODE, mutationFn: testAdminConnection })
}
