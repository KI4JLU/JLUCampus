import {
  QueryCache,
  QueryClient,
  queryOptions,
  type Mutation,
  useMutation,
  useQuery,
  useQueryClient,
  type DataTag,
  type UndefinedInitialDataOptions,
  type UseMutationResult,
  type UseQueryResult
} from '@tanstack/react-query'
import {
  ANNOUNCEMENTS_API,
  API,
  rephraseResponseSchema,
  translateResponseSchema,
  translatorComposeResponseSchema,
  translatorPythonResponseSchema,
  translatorDetectResponseSchema,
  translatorDocumentListSchema,
  translatorDocumentSchema,
  translatorEngineListSchema,
  translatorGlossaryDetailSchema,
  translatorGlossaryListSchema,
  translatorModelListSchema,
  translatorSuggestResponseSchema,
  type AdminAnnouncement,
  type AdminAnnouncementList,
  type AdminComponent,
  type AdminComponentList,
  type AnnouncementInput,
  type AdminUser,
  type AdminUserList,
  type Component,
  type ComponentInput,
  type ComponentList,
  type Dashboard,
  type DashboardTile,
  type FeedReadPut,
  type FolderTemplate,
  type FolderTemplateInput,
  type FolderTemplateList,
  type LayoutPreset,
  type LayoutPresetInput,
  type LayoutPresetList,
  type Me,
  type MePatch,
  type PresetAudienceSuggestions,
  type RephraseRequest,
  type RephraseResponse,
  type Sidebar,
  type TranslateRequest,
  type TranslateResponse,
  type TranslatorComposeRequest,
  type TranslatorComposeResponse,
  type TranslatorDetectRequest,
  type TranslatorDocument,
  type TranslatorEngineList,
  type TranslatorFormality,
  type TranslatorGlossaryDetail,
  type TranslatorGlossaryImport,
  type TranslatorGlossaryInput,
  type TranslatorGlossaryList,
  type TranslatorGlossaryPatch,
  type TranslatorLanguage,
  type TranslatorLlmModel,
  type TranslatorModelsRequest,
  type TranslatorPythonResponse,
  type TranslatorSuggestRequest,
  type UserAnnouncementList,
  type UserFeed,
  type UserRole,
  type WidgetList
} from '@justcampus/shared'
import { transcriptionKeys } from '@/adapters/transcription/api'
import { ApiRequestError, apiFetch, isUnauthorized } from './api'
import { applyComponentInput } from './component-secrets'
import { isLater } from './feed'

let onUnauthorized: (() => void) | undefined

/** Called when any query answers 401, i.e. the session ended while the app was open. */
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => {
      if (isUnauthorized(error)) onUnauthorized?.()
    }
  }),
  defaultOptions: {
    queries: {
      retry: (count, error) => !isUnauthorized(error) && count < 2,
      refetchOnWindowFocus: false,
      staleTime: 30_000
    },
    mutations: { retry: false }
  }
})

export const queryKeys = {
  me: ['me'] as const,
  components: ['components'] as const,
  widgets: ['widgets'] as const,
  sidebar: ['sidebar'] as const,
  dashboard: ['dashboard'] as const,
  adminComponents: ['admin', 'components'] as const,
  adminComponent: (id: string) => ['admin', 'component', id] as const,
  folderTemplates: ['folder-templates'] as const,
  adminFolderTemplates: ['admin', 'folder-templates'] as const,
  adminPresets: ['admin', 'presets'] as const,
  adminPreset: (id: string) => ['admin', 'preset', id] as const,
  adminPresetAudiences: ['admin', 'preset-audiences'] as const,
  adminUsers: ['admin', 'users'] as const,
  announcements: ['announcements'] as const,
  adminAnnouncements: ['admin', 'announcements'] as const,
  adminAnnouncement: (id: string) => ['admin', 'announcement', id] as const,
  feed: (url: string) => ['feed', url] as const,
  translatorEngines: ['translator', 'engines'] as const,
  translatorDocuments: ['translator', 'documents'] as const,
  translatorGlossaries: ['translator', 'glossaries'] as const
}

/**
 * The app shell keeps this query mounted, so it doubles as a heartbeat: each request lets the
 * server keep the Keycloak session alive that embedded sites sign in with (`keycloak-session.ts`
 * on the server), also while the user works inside an embedded site, records or transcribes.
 */
export const meQuery = queryOptions({
  queryKey: queryKeys.me,
  queryFn: () => apiFetch<Me>(API.me),
  staleTime: 5 * 60_000,
  refetchInterval: 4 * 60_000,
  refetchIntervalInBackground: true
})

/**
 * A fresh round trip before an embedded site loads. The server ends a session whose Keycloak
 * session has ended, so the app shows its login page instead of a site that would meet Keycloak's
 * login inside its frame, which Keycloak refuses to show there.
 */
export function useSessionCheck(componentId: string): UseQueryResult<Me> {
  return useQuery({
    queryKey: ['session-check', componentId],
    queryFn: () => apiFetch<Me>(API.me),
    staleTime: 0,
    gcTime: 0,
    retry: false
  })
}

export const componentsQuery = queryOptions({
  queryKey: queryKeys.components,
  queryFn: () => apiFetch<ComponentList>(API.components),
  select: (data) => data.components
})

/** Every widget of every enabled component; join with `componentsQuery` for names and icons. */
export const widgetsQuery = queryOptions({
  queryKey: queryKeys.widgets,
  queryFn: () => apiFetch<WidgetList>(API.widgets),
  select: (data) => data.widgets
})

export const sidebarQuery = queryOptions({
  queryKey: queryKeys.sidebar,
  queryFn: () => apiFetch<Sidebar>(API.sidebar),
  select: (data) => data.componentIds
})

export const dashboardQuery = queryOptions({
  queryKey: queryKeys.dashboard,
  queryFn: () => apiFetch<Dashboard>(API.dashboard),
  select: (data) => data.tiles
})

type FeedQueryKey = ReturnType<typeof queryKeys.feed>
type FeedQueryOptions = UndefinedInitialDataOptions<UserFeed, Error, UserFeed, FeedQueryKey> & {
  queryKey: DataTag<FeedQueryKey, UserFeed, Error>
}

/**
 * A feed as the server fetched and normalised it, with when the user last read
 * it. Fetching does not mark it read (see `useFeed`). Feeds change slowly and the
 * server caches them, so tiles refresh every ten minutes. A feed the server
 * could not reach (`feed_unavailable`) or a rejected URL is not retried: the
 * server has already tried, and the answer will not change within seconds.
 */
export function feedQuery(url: string): FeedQueryOptions {
  return queryOptions({
    queryKey: queryKeys.feed(url),
    queryFn: ({ signal }) =>
      apiFetch<UserFeed>(`${API.feed}?${new URLSearchParams({ url })}`, { signal }),
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
    retry: (count, error) => !(error instanceof ApiRequestError) && count < 2
  })
}

/**
 * The engines the translator offers. Checked against the contract like the
 * module's other answers; an answer from the server (a disabled module) is
 * not retried.
 */
export const translatorEnginesQuery = queryOptions({
  queryKey: queryKeys.translatorEngines,
  queryFn: async ({ signal }) =>
    translatorEngineListSchema.parse(await apiFetch<unknown>(API.translatorEngines, { signal })),
  retry: (count, error) => !(error instanceof ApiRequestError) && count < 2
})

export function useTranslatorEngines(): UseQueryResult<TranslatorEngineList> {
  return useQuery(translatorEnginesQuery)
}

/** How often the document list is fetched again while a job is still running. */
const DOCUMENT_POLL_MS = 3000

/**
 * The user's document jobs, newest first. While one is queued or translating the list is
 * fetched again every few seconds; the server follows the jobs at DeepL in the meantime.
 */
export function useTranslatorDocuments(enabled: boolean): UseQueryResult<TranslatorDocument[]> {
  return useQuery({
    queryKey: queryKeys.translatorDocuments,
    queryFn: async ({ signal }) =>
      translatorDocumentListSchema.parse(
        await apiFetch<unknown>(API.translatorDocuments, { signal })
      ).documents,
    enabled,
    retry: (count, error) => !(error instanceof ApiRequestError) && count < 2,
    refetchInterval: (query) =>
      query.state.data?.some((job) => job.status === 'queued' || job.status === 'translating')
        ? DOCUMENT_POLL_MS
        : false
  })
}

/** One file with its languages; `source` `null` lets DeepL detect it. */
export interface DocumentUploadRequest {
  file: File
  source: TranslatorLanguage | null
  target: TranslatorLanguage
  formality: TranslatorFormality
  glossaryIds: readonly string[]
}

/**
 * The translator's requests go out even when the browser says it is offline, and fail at once
 * then, as HAWKI's do: a request paused until the network is back would look like one still on
 * its way.
 */
const TRANSLATOR_NETWORK_MODE = 'always' as const

/** Uploads one document for translation; the new job heads the list right away. */
export function useUploadTranslatorDocument(): UseMutationResult<
  TranslatorDocument,
  Error,
  DocumentUploadRequest
> {
  const client = useQueryClient()
  return useMutation({
    networkMode: TRANSLATOR_NETWORK_MODE,
    mutationFn: async ({ file, source, target, formality, glossaryIds }) => {
      const form = new FormData()
      form.set('file', file)
      form.set('source', source ?? '')
      form.set('target', target)
      form.set('formality', formality)
      for (const id of glossaryIds) form.append('glossaryId', id)
      return translatorDocumentSchema.parse(
        await apiFetch<unknown>(API.translatorDocuments, { method: 'POST', form })
      )
    },
    onSuccess: (job) => {
      client.setQueryData<TranslatorDocument[]>(queryKeys.translatorDocuments, (jobs) => [
        job,
        ...(jobs ?? []).filter((other) => other.id !== job.id)
      ])
      void client.invalidateQueries({ queryKey: queryKeys.translatorDocuments })
    }
  })
}

/** Deletes one of the user's document jobs and its file. */
export function useDeleteTranslatorDocument(): UseMutationResult<void, Error, string> {
  const client = useQueryClient()
  return useMutation({
    networkMode: TRANSLATOR_NETWORK_MODE,
    mutationFn: (id: string) => apiFetch<void>(API.translatorDocument(id), { method: 'DELETE' }),
    onSuccess: (_, id) => {
      client.setQueryData<TranslatorDocument[]>(queryKeys.translatorDocuments, (jobs) =>
        jobs?.filter((job) => job.id !== id)
      )
    }
  })
}

/** Every component, disabled ones too, with which of its secrets are set. */
export const adminComponentsQuery = queryOptions({
  queryKey: queryKeys.adminComponents,
  queryFn: () => apiFetch<AdminComponentList>(API.adminComponents),
  select: (data) => data.components
})

type ComponentQueryKey = ReturnType<typeof queryKeys.adminComponent>
type ComponentQueryOptions = UndefinedInitialDataOptions<
  AdminComponent,
  Error,
  AdminComponent,
  ComponentQueryKey
> & {
  queryKey: DataTag<ComponentQueryKey, AdminComponent, Error>
}

/**
 * One component for its editor, fresh from the server whenever the editor opens (the list may
 * have changed it meanwhile). While the editor is open, only its own saves change the entry, so
 * the form's baseline never shifts under it. An answer from the server (`not_found`) is not
 * retried.
 */
export function adminComponentQuery(id: string): ComponentQueryOptions {
  return queryOptions({
    queryKey: queryKeys.adminComponent(id),
    queryFn: () => apiFetch<AdminComponent>(API.adminComponent(id)),
    staleTime: Infinity,
    gcTime: 0,
    retry: (count, error) => !(error instanceof ApiRequestError) && count < 2
  })
}

/** Enabled folder templates, offered in the "add widget" dialog. */
export const folderTemplatesQuery = queryOptions({
  queryKey: queryKeys.folderTemplates,
  queryFn: () => apiFetch<FolderTemplateList>(API.folderTemplates),
  select: (data) => data.folders
})

export const adminFolderTemplatesQuery = queryOptions({
  queryKey: queryKeys.adminFolderTemplates,
  queryFn: () => apiFetch<FolderTemplateList>(API.adminFolderTemplates),
  select: (data) => data.folders
})

/** Every preset in match order, the `everyone` preset last. */
export const adminPresetsQuery = queryOptions({
  queryKey: queryKeys.adminPresets,
  queryFn: () => apiFetch<LayoutPresetList>(API.adminPresets),
  select: (data) => data.presets
})

type PresetQueryKey = ReturnType<typeof queryKeys.adminPreset>
type PresetQueryOptions = UndefinedInitialDataOptions<
  LayoutPreset,
  Error,
  LayoutPreset,
  PresetQueryKey
> & {
  queryKey: DataTag<PresetQueryKey, LayoutPreset, Error>
}

/**
 * One preset for its editor. The editor writes its changes into this entry at once, so it is
 * not refetched in the background while saves may still be on their way. An answer from the
 * server (a deleted preset's `not_found`) is not retried.
 */
export function adminPresetQuery(id: string): PresetQueryOptions {
  return queryOptions({
    queryKey: queryKeys.adminPreset(id),
    queryFn: () => apiFetch<LayoutPreset>(API.adminPreset(id)),
    staleTime: Infinity,
    retry: (count, error) => !(error instanceof ApiRequestError) && count < 2
  })
}

/** Role and group names seen at sign-ins, suggested in the audience field. */
export const adminPresetAudiencesQuery = queryOptions({
  queryKey: queryKeys.adminPresetAudiences,
  queryFn: () => apiFetch<PresetAudienceSuggestions>(API.adminPresetAudiences),
  staleTime: 5 * 60_000
})

/** Every user who ever signed in, admins first, then by name. */
export const adminUsersQuery = queryOptions({
  queryKey: queryKeys.adminUsers,
  queryFn: () => apiFetch<AdminUserList>(API.adminUsers),
  select: (data) => data.users
})

/**
 * The announcements meant for the user, with both languages. Polled rarely: news open when the app
 * starts, and a hint published meanwhile can wait a few minutes. An answer from the server is not
 * retried; announcements are never worth an error on screen.
 */
export const announcementsQuery = queryOptions({
  queryKey: queryKeys.announcements,
  queryFn: () => apiFetch<UserAnnouncementList>(ANNOUNCEMENTS_API.announcements),
  select: (data) => data.announcements,
  staleTime: 5 * 60_000,
  refetchInterval: 15 * 60_000,
  retry: (count, error) => !(error instanceof ApiRequestError) && count < 2
})

/** Every announcement, drafts too, newest first, with how many users acknowledged each. */
export const adminAnnouncementsQuery = queryOptions({
  queryKey: queryKeys.adminAnnouncements,
  queryFn: () => apiFetch<AdminAnnouncementList>(ANNOUNCEMENTS_API.admin),
  select: (data) => data.announcements
})

type AnnouncementQueryKey = ReturnType<typeof queryKeys.adminAnnouncement>
type AnnouncementQueryOptions = UndefinedInitialDataOptions<
  AdminAnnouncement,
  Error,
  AdminAnnouncement,
  AnnouncementQueryKey
> & {
  queryKey: DataTag<AnnouncementQueryKey, AdminAnnouncement, Error>
}

/** One announcement for its editor; fetched like `adminComponentQuery`, for the same reasons. */
export function adminAnnouncementQuery(id: string): AnnouncementQueryOptions {
  return queryOptions({
    queryKey: queryKeys.adminAnnouncement(id),
    queryFn: () => apiFetch<AdminAnnouncement>(ANNOUNCEMENTS_API.adminOne(id)),
    staleTime: Infinity,
    gcTime: 0,
    retry: (count, error) => !(error instanceof ApiRequestError) && count < 2
  })
}

export function useUpdateMe(): UseMutationResult<Me, Error, MePatch> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (patch: MePatch) => apiFetch<Me>(API.me, { method: 'PATCH', json: patch }),
    onSuccess: (me) => client.setQueryData(queryKeys.me, me)
  })
}

const feedReadMutationKey = ['feed-read'] as const

/**
 * Marks a feed read as of the copy the user saw. The cached copy then carries the new `readAt`,
 * so every view of the feed shows its entries as read; the server never moves `readAt` back, and
 * neither does the cache.
 */
export function useMarkFeedRead(): UseMutationResult<void, Error, FeedReadPut> {
  const client = useQueryClient()
  return useMutation({
    mutationKey: feedReadMutationKey,
    mutationFn: (read: FeedReadPut) => apiFetch<void>(API.feedRead, { method: 'PUT', json: read }),
    onSuccess: (_data, { url, readAt }) =>
      client.setQueryData<UserFeed>(queryKeys.feed(url), (feed) =>
        feed && (feed.readAt === null || isLater(readAt, feed.readAt)) ? { ...feed, readAt } : feed
      )
  })
}

/** Whether a request marking exactly this read is already on its way, e.g. from another view. */
export function isMarkingFeedRead(client: QueryClient, { url, readAt }: FeedReadPut): boolean {
  const matches = (mutation: Mutation<unknown, unknown, unknown>): boolean => {
    const read = mutation.state.variables as FeedReadPut | undefined
    return read?.url === url && read.readAt === readAt
  }
  return client.isMutating({ mutationKey: feedReadMutationKey, predicate: matches }) > 0
}

interface OptimisticContext<T> {
  previous: T | undefined
}

/** Replaces the sidebar optimistically; the caller shows the error, the cache rolls back. */
export function useSaveSidebar(): UseMutationResult<
  Sidebar,
  Error,
  string[],
  OptimisticContext<Sidebar>
> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (componentIds: string[]) =>
      apiFetch<Sidebar>(API.sidebar, { method: 'PUT', json: { componentIds } }),
    onMutate: async (componentIds) => {
      await client.cancelQueries({ queryKey: queryKeys.sidebar })
      const previous = client.getQueryData<Sidebar>(queryKeys.sidebar)
      client.setQueryData<Sidebar>(queryKeys.sidebar, { componentIds })
      return { previous }
    },
    onError: (_error, _ids, context) => {
      if (context?.previous) client.setQueryData(queryKeys.sidebar, context.previous)
    },
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.sidebar })
  })
}

/** Replaces the dashboard; the cache shows the new tiles at once and refetches on failure. */
export function useSaveDashboard(
  onError?: () => void
): UseMutationResult<Dashboard, Error, DashboardTile[]> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (tiles: DashboardTile[]) =>
      apiFetch<Dashboard>(API.dashboard, { method: 'PUT', json: { tiles } }),
    onMutate: (tiles) => client.setQueryData<Dashboard>(queryKeys.dashboard, { tiles }),
    onError: () => {
      onError?.()
      return client.invalidateQueries({ queryKey: queryKeys.dashboard })
    }
  })
}

/**
 * Catalogue changes reach every user-facing list, so they all refetch. Folder
 * templates too: the widgets of a deleted or disabled component vanish from them.
 */
function invalidateCatalogue(client: QueryClient): Promise<void> {
  return Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.adminComponents }),
    client.invalidateQueries({ queryKey: queryKeys.components }),
    client.invalidateQueries({ queryKey: queryKeys.widgets }),
    client.invalidateQueries({ queryKey: queryKeys.sidebar }),
    client.invalidateQueries({ queryKey: queryKeys.dashboard }),
    client.invalidateQueries({ queryKey: queryKeys.translatorEngines }),
    client.invalidateQueries({ queryKey: transcriptionKeys.capabilities }),
    invalidateFolderTemplates(client)
  ]).then(() => undefined)
}

/** Template changes reach the admin list and the templates users are offered. */
function invalidateFolderTemplates(client: QueryClient): Promise<void> {
  return Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.adminFolderTemplates }),
    client.invalidateQueries({ queryKey: queryKeys.folderTemplates })
  ]).then(() => undefined)
}

export function useCreateComponent(): UseMutationResult<AdminComponent, Error, ComponentInput> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: ComponentInput) =>
      apiFetch<AdminComponent>(API.adminComponents, { method: 'POST', json: input }),
    onSuccess: () => invalidateCatalogue(client)
  })
}

/** Full replace of one component; the admin list shows the change at once (the enabled switch). */
export function useUpdateComponent(): UseMutationResult<
  AdminComponent,
  Error,
  { id: string; input: ComponentInput },
  OptimisticContext<AdminComponentList>
> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ComponentInput }) =>
      apiFetch<AdminComponent>(API.adminComponent(id), { method: 'PUT', json: input }),
    onMutate: async ({ id, input }) => {
      await client.cancelQueries({ queryKey: queryKeys.adminComponents })
      const previous = client.getQueryData<AdminComponentList>(queryKeys.adminComponents)
      if (previous) {
        const components = previous.components.map((component) =>
          component.id === id ? applyComponentInput(component, input) : component
        )
        client.setQueryData<AdminComponentList>(queryKeys.adminComponents, { components })
      }
      return { previous }
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) client.setQueryData(queryKeys.adminComponents, context.previous)
    },
    onSettled: () => invalidateCatalogue(client)
  })
}

/** The models an OpenAI-compatible endpoint offers, for the translator's admin form. */
export function useFetchTranslatorModels(): UseMutationResult<
  TranslatorLlmModel[],
  Error,
  TranslatorModelsRequest
> {
  return useMutation({
    mutationFn: async (request: TranslatorModelsRequest) =>
      translatorModelListSchema.parse(
        await apiFetch<unknown>(API.adminTranslatorModels, { method: 'POST', json: request })
      ).models
  })
}

/** A request to the translator module and the signal that aborts it once a newer one starts. */
export interface TranslatorCall<T> {
  request: T
  signal?: AbortSignal
}

/**
 * Translates one text with the translator module. The answer is checked
 * against the contract, since the module's upstream service is replaceable.
 */
export function useTranslate(): UseMutationResult<
  TranslateResponse,
  Error,
  TranslatorCall<TranslateRequest>
> {
  return useMutation({
    networkMode: TRANSLATOR_NETWORK_MODE,
    mutationFn: async ({ request, signal }: TranslatorCall<TranslateRequest>) =>
      translateResponseSchema.parse(
        await apiFetch<unknown>(API.translate, { method: 'POST', json: request, signal })
      )
  })
}

/** Translates a text sentence by sentence; checked like `useTranslate`. */
export async function translateText(
  request: TranslateRequest,
  signal?: AbortSignal
): Promise<TranslateResponse> {
  return translateResponseSchema.parse(
    await apiFetch<unknown>(API.translate, { method: 'POST', json: request, signal })
  )
}

/** Rewrites a text sentence by sentence in its own language. */
export async function rephraseText(
  request: RephraseRequest,
  signal?: AbortSignal
): Promise<RephraseResponse> {
  return rephraseResponseSchema.parse(
    await apiFetch<unknown>(API.rephrase, { method: 'POST', json: request, signal })
  )
}

/** The language of a text sample; `null` when it is not one the translator offers. */
export async function detectLanguage(
  request: TranslatorDetectRequest,
  signal?: AbortSignal
): Promise<TranslatorLanguage | null> {
  return translatorDetectResponseSchema.parse(
    await apiFetch<unknown>(API.translatorDetect, { method: 'POST', json: request, signal })
  ).language
}

/** Other wordings of a sentence, other words for a word, or a corrected sentence. */
export async function fetchSuggestions(
  request: TranslatorSuggestRequest,
  signal?: AbortSignal
): Promise<string[]> {
  return translatorSuggestResponseSchema.parse(
    await apiFetch<unknown>(API.translatorSuggest, { method: 'POST', json: request, signal })
  ).suggestions
}

/** One action of the AI editor on a passage. */
export async function composeText(
  request: TranslatorComposeRequest,
  signal?: AbortSignal
): Promise<TranslatorComposeResponse> {
  return translatorComposeResponseSchema.parse(
    await apiFetch<unknown>(API.translatorCompose, { method: 'POST', json: request, signal })
  )
}

/** Runs a Python code block of the AI editor on the server. */
export async function executePython(code: string): Promise<TranslatorPythonResponse> {
  return translatorPythonResponseSchema.parse(
    await apiFetch<unknown>(API.translatorExecutePython, { method: 'POST', json: { code } })
  )
}

/** The glossaries the user can apply: public ones and their own. */
export function useTranslatorGlossaries(): UseQueryResult<TranslatorGlossaryList> {
  return useQuery({
    queryKey: queryKeys.translatorGlossaries,
    queryFn: async ({ signal }) =>
      translatorGlossaryListSchema.parse(
        await apiFetch<unknown>(API.translatorGlossaries, { signal })
      ),
    retry: (count, error) => !(error instanceof ApiRequestError) && count < 2
  })
}

/** One glossary with its terms, for the edit form. */
export async function fetchGlossary(id: string): Promise<TranslatorGlossaryDetail> {
  return translatorGlossaryDetailSchema.parse(await apiFetch<unknown>(API.translatorGlossary(id)))
}

/** A new glossary (`id` left out) or all of an edited one. */
export function useSaveGlossary(): UseMutationResult<
  TranslatorGlossaryDetail,
  Error,
  { id?: string; input: TranslatorGlossaryInput }
> {
  const client = useQueryClient()
  return useMutation({
    networkMode: TRANSLATOR_NETWORK_MODE,
    mutationFn: async ({ id, input }) =>
      translatorGlossaryDetailSchema.parse(
        await apiFetch<unknown>(id ? API.translatorGlossary(id) : API.translatorGlossaries, {
          method: id ? 'PUT' : 'POST',
          json: input
        })
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.translatorGlossaries })
  })
}

/** Changes a glossary's description or visibility. */
export function usePatchGlossary(): UseMutationResult<
  TranslatorGlossaryDetail,
  Error,
  { id: string; patch: TranslatorGlossaryPatch }
> {
  const client = useQueryClient()
  return useMutation({
    networkMode: TRANSLATOR_NETWORK_MODE,
    mutationFn: async ({ id, patch }) =>
      translatorGlossaryDetailSchema.parse(
        await apiFetch<unknown>(API.translatorGlossary(id), { method: 'PATCH', json: patch })
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.translatorGlossaries })
  })
}

export function useDeleteGlossary(): UseMutationResult<void, Error, string> {
  const client = useQueryClient()
  return useMutation({
    networkMode: TRANSLATOR_NETWORK_MODE,
    mutationFn: (id: string) => apiFetch<void>(API.translatorGlossary(id), { method: 'DELETE' }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.translatorGlossaries })
  })
}

/** Creates a glossary from a CSV file of term pairs. */
export function useImportGlossary(): UseMutationResult<
  TranslatorGlossaryDetail,
  Error,
  TranslatorGlossaryImport & { file: File }
> {
  const client = useQueryClient()
  return useMutation({
    networkMode: TRANSLATOR_NETWORK_MODE,
    mutationFn: async ({ file, name, description, sourceLanguage, targetLanguage }) => {
      const form = new FormData()
      form.set('file', file)
      form.set('name', name)
      form.set('description', description ?? '')
      form.set('sourceLanguage', sourceLanguage)
      form.set('targetLanguage', targetLanguage)
      return translatorGlossaryDetailSchema.parse(
        await apiFetch<unknown>(API.translatorGlossaryImport, { method: 'POST', form })
      )
    },
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.translatorGlossaries })
  })
}

export function useDeleteComponent(): UseMutationResult<void, Error, string> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(API.adminComponent(id), { method: 'DELETE' }),
    onSuccess: () => invalidateCatalogue(client)
  })
}

export function useReorderComponents(): UseMutationResult<
  void,
  Error,
  string[],
  OptimisticContext<AdminComponentList>
> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (ids: string[]) =>
      apiFetch<void>(API.adminComponentOrder, { method: 'PUT', json: { ids } }),
    onMutate: async (ids) => {
      await client.cancelQueries({ queryKey: queryKeys.adminComponents })
      const previous = client.getQueryData<AdminComponentList>(queryKeys.adminComponents)
      if (previous) {
        const byId = new Map(previous.components.map((component) => [component.id, component]))
        const components = ids.flatMap((id) => byId.get(id) ?? [])
        client.setQueryData<AdminComponentList>(queryKeys.adminComponents, { components })
      }
      return { previous }
    },
    onError: (_error, _ids, context) => {
      if (context?.previous) client.setQueryData(queryKeys.adminComponents, context.previous)
    },
    onSettled: () => invalidateCatalogue(client)
  })
}

export function useCreateFolderTemplate(): UseMutationResult<
  FolderTemplate,
  Error,
  FolderTemplateInput
> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: FolderTemplateInput) =>
      apiFetch<FolderTemplate>(API.adminFolderTemplates, { method: 'POST', json: input }),
    onSuccess: () => invalidateFolderTemplates(client)
  })
}

/** Full replace of one template; the admin list shows the change at once (the enabled switch). */
export function useUpdateFolderTemplate(): UseMutationResult<
  FolderTemplate,
  Error,
  { id: string; input: FolderTemplateInput },
  OptimisticContext<FolderTemplateList>
> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: FolderTemplateInput }) =>
      apiFetch<FolderTemplate>(API.adminFolderTemplate(id), { method: 'PUT', json: input }),
    onMutate: async ({ id, input }) => {
      await client.cancelQueries({ queryKey: queryKeys.adminFolderTemplates })
      const previous = client.getQueryData<FolderTemplateList>(queryKeys.adminFolderTemplates)
      if (previous) {
        const folders = previous.folders.map((folder) =>
          folder.id === id ? { ...folder, ...input } : folder
        )
        client.setQueryData<FolderTemplateList>(queryKeys.adminFolderTemplates, { folders })
      }
      return { previous }
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) client.setQueryData(queryKeys.adminFolderTemplates, context.previous)
    },
    onSettled: () => invalidateFolderTemplates(client)
  })
}

export function useDeleteFolderTemplate(): UseMutationResult<void, Error, string> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(API.adminFolderTemplate(id), { method: 'DELETE' }),
    onSuccess: () => invalidateFolderTemplates(client)
  })
}

export function useReorderFolderTemplates(): UseMutationResult<
  void,
  Error,
  string[],
  OptimisticContext<FolderTemplateList>
> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (ids: string[]) =>
      apiFetch<void>(API.adminFolderTemplateOrder, { method: 'PUT', json: { ids } }),
    onMutate: async (ids) => {
      await client.cancelQueries({ queryKey: queryKeys.adminFolderTemplates })
      const previous = client.getQueryData<FolderTemplateList>(queryKeys.adminFolderTemplates)
      if (previous) {
        const byId = new Map(previous.folders.map((folder) => [folder.id, folder]))
        const folders = ids.flatMap((id) => byId.get(id) ?? [])
        client.setQueryData<FolderTemplateList>(queryKeys.adminFolderTemplates, { folders })
      }
      return { previous }
    },
    onError: (_error, _ids, context) => {
      if (context?.previous) client.setQueryData(queryKeys.adminFolderTemplates, context.previous)
    },
    onSettled: () => invalidateFolderTemplates(client)
  })
}

/** Creates a preset; its editor then opens from the cache without a request. */
export function useCreateLayoutPreset(): UseMutationResult<LayoutPreset, Error, LayoutPresetInput> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: LayoutPresetInput) =>
      apiFetch<LayoutPreset>(API.adminPresets, { method: 'POST', json: input }),
    onSuccess: (preset) => {
      client.setQueryData(queryKeys.adminPreset(preset.id), preset)
      return client.invalidateQueries({ queryKey: queryKeys.adminPresets })
    }
  })
}

/**
 * Full replace of one preset; its editor shows the change at once. Saves share one mutation
 * scope, so they run one after another and reach the server in the order they were made. A
 * failed save refetches the preset, so the editor shows what the server kept.
 */
export function useUpdateLayoutPreset(): UseMutationResult<
  LayoutPreset,
  Error,
  { id: string; input: LayoutPresetInput }
> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: LayoutPresetInput }) =>
      apiFetch<LayoutPreset>(API.adminPreset(id), { method: 'PUT', json: input }),
    scope: { id: 'admin-presets' },
    onMutate: ({ id, input }) => {
      const previous = client.getQueryData<LayoutPreset>(queryKeys.adminPreset(id))
      if (previous) {
        client.setQueryData<LayoutPreset>(queryKeys.adminPreset(id), { ...previous, ...input })
      }
    },
    onError: (_error, { id }) => client.invalidateQueries({ queryKey: queryKeys.adminPreset(id) }),
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.adminPresets })
  })
}

/**
 * Deletes a preset. Its cached copy goes too unless its editor is still open; the editor leaves
 * the page and drops the copy itself, rather than refetching a preset that is gone.
 */
export function useDeleteLayoutPreset(): UseMutationResult<void, Error, string> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(API.adminPreset(id), { method: 'DELETE' }),
    onSuccess: (_data, id) => {
      client.removeQueries({ queryKey: queryKeys.adminPreset(id), type: 'inactive' })
      return client.invalidateQueries({ queryKey: queryKeys.adminPresets })
    }
  })
}

export function useReorderLayoutPresets(): UseMutationResult<
  void,
  Error,
  string[],
  OptimisticContext<LayoutPresetList>
> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (ids: string[]) =>
      apiFetch<void>(API.adminPresetOrder, { method: 'PUT', json: { ids } }),
    onMutate: async (ids) => {
      await client.cancelQueries({ queryKey: queryKeys.adminPresets })
      const previous = client.getQueryData<LayoutPresetList>(queryKeys.adminPresets)
      if (previous) {
        const byId = new Map(previous.presets.map((preset) => [preset.id, preset]))
        const presets = ids.flatMap((id) => byId.get(id) ?? [])
        client.setQueryData<LayoutPresetList>(queryKeys.adminPresets, { presets })
      }
      return { previous }
    },
    onError: (_error, _ids, context) => {
      if (context?.previous) client.setQueryData(queryKeys.adminPresets, context.previous)
    },
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.adminPresets })
  })
}

/**
 * Grants or revokes a user's admin role. The list shows the answer at once and is then refetched
 * for the server's order, admins first.
 */
export function useSetUserRole(): UseMutationResult<
  AdminUser,
  Error,
  { id: string; role: UserRole }
> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, role }: { id: string; role: UserRole }) =>
      apiFetch<AdminUser>(API.adminUser(id), { method: 'PATCH', json: { role } }),
    onSuccess: (user) => {
      client.setQueryData<AdminUserList>(queryKeys.adminUsers, (list) =>
        list ? { users: list.users.map((item) => (item.id === user.id ? user : item)) } : list
      )
      return client.invalidateQueries({ queryKey: queryKeys.adminUsers })
    }
  })
}

/**
 * Marks an announcement acknowledged. The cached list says so at once and keeps saying so when the
 * request fails, so a hint the user closed does not come back before the next refetch.
 */
export function useMarkAnnouncementSeen(): UseMutationResult<void, Error, string> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(ANNOUNCEMENTS_API.seen(id), { method: 'POST' }),
    onMutate: async (id) => {
      await client.cancelQueries({ queryKey: queryKeys.announcements })
      client.setQueryData<UserAnnouncementList>(queryKeys.announcements, (list) =>
        list
          ? {
              announcements: list.announcements.map((item) =>
                item.id === id ? { ...item, seen: true } : item
              )
            }
          : list
      )
    }
  })
}

/** Announcement changes reach the admin list and what users are shown (the admin is one). */
function invalidateAnnouncements(client: QueryClient): Promise<void> {
  return Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.adminAnnouncements }),
    client.invalidateQueries({ queryKey: queryKeys.announcements })
  ]).then(() => undefined)
}

export function useCreateAnnouncement(): UseMutationResult<
  AdminAnnouncement,
  Error,
  AnnouncementInput
> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: AnnouncementInput) =>
      apiFetch<AdminAnnouncement>(ANNOUNCEMENTS_API.admin, { method: 'POST', json: input }),
    onSuccess: () => invalidateAnnouncements(client)
  })
}

export function useUpdateAnnouncement(): UseMutationResult<
  AdminAnnouncement,
  Error,
  { id: string; input: AnnouncementInput }
> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: AnnouncementInput }) =>
      apiFetch<AdminAnnouncement>(ANNOUNCEMENTS_API.adminOne(id), { method: 'PUT', json: input }),
    onSuccess: () => invalidateAnnouncements(client)
  })
}

export function useDeleteAnnouncement(): UseMutationResult<void, Error, string> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(ANNOUNCEMENTS_API.adminOne(id), { method: 'DELETE' }),
    onSuccess: () => invalidateAnnouncements(client)
  })
}

/** Forgets every acknowledgement of an announcement, so all users see it again. */
export function useResetAnnouncement(): UseMutationResult<AdminAnnouncement, Error, string> {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<AdminAnnouncement>(ANNOUNCEMENTS_API.adminReset(id), { method: 'POST' }),
    onSuccess: () => invalidateAnnouncements(client)
  })
}

/** The input shape of an existing preset, for full-replace PUTs. */
export function toLayoutPresetInput(preset: LayoutPreset): LayoutPresetInput {
  const { name, audience, sidebar, dashboard } = preset
  return { name, audience, sidebar, dashboard }
}

/** The input shape of an existing template, for full-replace PUTs. */
export function toFolderTemplateInput(template: FolderTemplate): FolderTemplateInput {
  const { name, icon, enabled, widgets } = template
  return { name, icon, enabled, widgets }
}

/**
 * The shared input shape of an existing component, for full-replace PUTs.
 * Secrets are left out, so they stay as they are.
 */
export function toComponentInput(component: Component): ComponentInput {
  const { name, icon, iconUrl, enabled } = component
  const base = { name, icon, iconUrl, enabled }
  switch (component.type) {
    case 'iframe':
      return { ...base, type: component.type, config: component.config }
    case 'rss':
      return { ...base, type: component.type, config: component.config }
    case 'link':
      return { ...base, type: component.type, config: component.config }
    case 'translator':
      return { ...base, type: component.type, config: component.config }
    case 'transcription':
      return { ...base, type: component.type, config: component.config }
    case 'files':
      return { ...base, type: component.type, config: component.config }
  }
}
