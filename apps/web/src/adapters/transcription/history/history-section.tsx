import { useEffect, useId, useState } from 'react'
import { FileTextIcon, PencilIcon, SearchIcon, Trash2Icon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  PanelSection,
  SidebarCard,
  SidebarCardList,
  Spinner
} from '@ki4jlu/design-system'
import {
  TRANSCRIPTION_HISTORY_TITLE_MAX,
  type TranscriptionTranscriptSummary
} from '@justcampus/shared'
import { ApiRequestError } from '@/lib/api'
import { toast } from '@/lib/toast'
import {
  getTranscript,
  listTranscripts,
  patchTranscript,
  transcriptionKeys,
  useDeleteTranscript
} from '../api'
import { NameInput } from '../result/name-input'
import { useResultSession } from '../result/session'
import { useTranscriptionWorkspace } from '../use-workspace'
import {
  changeLocalHistory,
  syncLocalHistory,
  updateRecord,
  useLocalHistory,
  withoutRecord
} from './local-store'
import { groupHistory, mergeHistory, type HistoryEntry, type HistoryGroupKey } from './model'
import { useNow } from './now'

/** kiChat retries a failed history fetch once, after 250 ms (T-39). */
const HISTORY_RETRY_MS = 250

const GROUP_LABELS = {
  today: 'transcription.result.today',
  yesterday: 'transcription.result.yesterday',
  last7: 'transcription.result.last7Days',
  older: 'transcription.result.older'
} as const satisfies Record<HistoryGroupKey, string>

/**
 * The user's saved transcripts in the side column (T-37 to T-40), after kiChat's history: newest
 * change first in date groups, a title search, and per entry rename and delete. The server's list
 * is authoritative; while it cannot be loaded the titles this browser kept stand in, and
 * transcripts only this browser has are listed too.
 */
export function HistorySection(): React.JSX.Element {
  const { t } = useTranslation()
  const client = useQueryClient()
  const headingId = useId()
  const {
    component,
    view,
    transcriptId,
    openTranscript,
    newTranscription,
    historySearch,
    setHistorySearch
  } = useTranscriptionWorkspace()
  const session = useResultSession()
  const list = useQuery({
    queryKey: transcriptionKeys.transcripts,
    queryFn: ({ signal }) => listTranscripts(signal),
    // Network failures and server errors may pass; refusals do not.
    retry: (count, error) =>
      count < 1 && (!(error instanceof ApiRequestError) || error.status >= 500),
    retryDelay: HISTORY_RETRY_MS,
    networkMode: 'always'
  })
  const { key, records } = useLocalHistory(component.id)
  const now = useNow()
  const remove = useDeleteTranscript()
  const [renaming, setRenaming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<HistoryEntry | null>(null)
  const activeId = view === 'result' ? transcriptId : null

  // The server's list replaces what this browser kept of it.
  useEffect(() => {
    const server = list.data
    if (key && server) changeLocalHistory(key, (stored) => syncLocalHistory(stored, server))
  }, [key, list.data])

  const entries = mergeHistory(list.data, records)
  const groups = groupHistory(entries, historySearch, new Date(now))

  /** Renames an entry (T-40); kiChat's history field allows 35 characters. */
  const rename = async (entry: HistoryEntry, title: string): Promise<void> => {
    setRenaming(null)
    if (title === entry.title) return
    const open = session && session.id === entry.id ? session : null
    if (entry.local) {
      if (open) await open.setTitle(title)
      else if (key) {
        changeLocalHistory(key, (stored) =>
          updateRecord(stored, entry.id, (record) => ({
            ...record,
            title,
            transcript: record.transcript ? { ...record.transcript, title } : null
          }))
        )
      }
      return
    }
    let saved = false
    if (open) saved = await open.setTitle(title)
    else {
      try {
        const latest = await getTranscript(entry.id)
        const changed = await patchTranscript(entry.id, { baseRevision: latest.revision, title })
        client.setQueryData(transcriptionKeys.transcript(entry.id), changed)
        client.setQueryData<TranscriptionTranscriptSummary[]>(
          transcriptionKeys.transcripts,
          (current) =>
            current?.map((item) =>
              item.id === entry.id
                ? { ...item, title: changed.title, updatedAt: changed.updatedAt }
                : item
            )
        )
        saved = true
      } catch {
        saved = false
      }
    }
    if (!saved) toast({ variant: 'error', title: t('transcription.result.titleSaveFailed') })
  }

  /** Deleted for good: out of the list, and the workspace back to the choice if it was open. */
  const deleted = (entry: HistoryEntry): void => {
    if (key) changeLocalHistory(key, (stored) => withoutRecord(stored, entry.id))
    setDeleting(null)
    if (entry.id === activeId) {
      if (session?.id === entry.id) session.discard()
      void newTranscription()
    }
  }

  const confirmDelete = (): void => {
    const entry = deleting
    if (!entry) return
    if (entry.local) {
      deleted(entry)
      return
    }
    remove.mutate(entry.id, {
      onSuccess: () => deleted(entry),
      onError: (error) => {
        // Already gone on the server: it leaves the list all the same.
        if (error instanceof ApiRequestError && error.status === 404) {
          client.setQueryData<TranscriptionTranscriptSummary[]>(
            transcriptionKeys.transcripts,
            (current) => current?.filter((item) => item.id !== entry.id)
          )
          deleted(entry)
          return
        }
        toast({ variant: 'error', title: t('transcription.result.deleteFailed') })
      }
    })
  }

  return (
    <PanelSection title={t('transcription.result.history')} titleId={headingId}>
      <Input
        type="search"
        value={historySearch}
        onChange={(event) => setHistorySearch(event.target.value)}
        placeholder={t('transcription.result.searchPlaceholder')}
        aria-label={t('transcription.result.searchPlaceholder')}
        leadingIcon={<SearchIcon aria-hidden="true" className="size-4" />}
      />
      {list.isError && !list.data ? (
        <div className="flex flex-wrap items-center gap-2">
          <span>{t('transcription.result.historyLoadFailed')}</span>
          <Button type="button" variant="outline" onClick={() => void list.refetch()}>
            {t('transcription.common.retry')}
          </Button>
        </div>
      ) : null}
      {list.isPending && entries.length === 0 ? (
        <Spinner label={t('transcription.common.loading')} />
      ) : groups.length === 0 ? (
        <p className="m-0">
          {entries.length === 0
            ? t('transcription.result.historyEmpty')
            : t('transcription.result.historyNoMatch')}
        </p>
      ) : (
        groups.map((group) => (
          <section
            key={group.key}
            aria-labelledby={`${headingId}-${group.key}`}
            className="flex flex-col gap-1"
          >
            <h4 id={`${headingId}-${group.key}`} className="m-0">
              {t(GROUP_LABELS[group.key])}
            </h4>
            <SidebarCardList>
              {group.entries.map((entry) =>
                renaming === entry.id ? (
                  <li key={entry.id} className="flex items-center gap-1">
                    <NameInput
                      label={t('transcription.result.renameLabel')}
                      initial={entry.title}
                      maxLength={TRANSCRIPTION_HISTORY_TITLE_MAX}
                      onSubmit={(title) => void rename(entry, title)}
                      onCancel={() => setRenaming(null)}
                    />
                  </li>
                ) : (
                  <SidebarCard
                    key={entry.id}
                    icon={<FileTextIcon aria-hidden="true" className="size-4" />}
                    title={entry.title}
                    active={entry.id === activeId}
                    onOpen={() => void openTranscript(entry.id)}
                    meta={entry.local ? t('transcription.result.historyLocal') : undefined}
                    actionsLabel={t('transcription.result.actionsFor')}
                    actions={[
                      {
                        label: t('transcription.result.rename'),
                        icon: <PencilIcon aria-hidden="true" className="size-4" />,
                        // After the menu has closed and given the focus back.
                        onSelect: () => requestAnimationFrame(() => setRenaming(entry.id))
                      },
                      {
                        label: t('transcription.common.delete'),
                        icon: <Trash2Icon aria-hidden="true" className="size-4" />,
                        destructive: true,
                        onSelect: () => requestAnimationFrame(() => setDeleting(entry))
                      }
                    ]}
                  />
                )
              )}
            </SidebarCardList>
          </section>
        ))
      )}

      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => (open || remove.isPending ? undefined : setDeleting(null))}
      >
        <DialogContent closeLabel={t('transcription.common.close')}>
          <DialogHeader>
            <DialogTitle>{t('transcription.result.deleteTitle')}</DialogTitle>
            <DialogDescription>{t('transcription.result.confirmDeleteEntry')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="secondary" disabled={remove.isPending}>
                {t('transcription.common.cancel')}
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant="destructive"
              disabled={remove.isPending}
              onClick={confirmDelete}
            >
              {t('transcription.common.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PanelSection>
  )
}
