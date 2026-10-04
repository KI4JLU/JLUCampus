import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Undo2Icon, WandSparklesIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import {
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Spinner
} from '@ki4jlu/design-system'
import type { TranscriptionTranscript, TranscriptionTranscriptSummary } from '@justcampus/shared'
import { ApiRequestError } from '@/lib/api'
import {
  generateSubtitle,
  getTranscript,
  optimizeSpeakers,
  patchTranscript,
  transcriptionKeys,
  useTranscript
} from '../api'
import { ExportView } from '../export'
import {
  changeLocalHistory,
  isLocalTranscriptId,
  keepServerCopy,
  serverCopy,
  updateRecord,
  useLocalHistory,
  withoutRecord
} from '../history/local-store'
import { Notice } from '../notice'
import {
  blockAt,
  blockCopyText,
  buildSpeakerBlocks,
  buildTranscriptText,
  formatTimestamp,
  totalDuration
} from '../segments'
import { useTranscriptionWorkspace } from '../use-workspace'
import { scrollToBlock } from './dom'
import { ResultHeader } from './header'
import { IconButton } from './icon-button'
import { formatExpiry, openingCopy } from './opening'
import { GlobalPlayer, type GlobalPlayerHandle } from './player'
import {
  closeResultSession,
  ensureResultSession,
  useResultSession,
  useResultState,
  type OptimizeResult,
  type ResultSession,
  type SessionDeps
} from './session'
import { Transcript } from './transcript'
import { useSpeakerLabel } from './use-speaker-label'

/**
 * The work area of a saved transcript (T-22 to T-36): loads it, from the server or, for one only
 * this browser has, from the local history, and opens its session.
 */
export function ResultView(): React.JSX.Element | null {
  const { transcriptId } = useTranscriptionWorkspace()
  if (!transcriptId) return null
  return isLocalTranscriptId(transcriptId) ? (
    <LocalResult id={transcriptId} />
  ) : (
    <ServerResult id={transcriptId} />
  )
}

function notAvailable(): Promise<never> {
  return Promise.reject(new Error('Not available for a local transcript'))
}

/** Opens the session of a loaded transcript and closes it when the view leaves it. */
function useOpenSession(
  id: string,
  transcript: TranscriptionTranscript | null,
  deps: SessionDeps,
  local: boolean,
  keptCopy = false
): ResultSession | null {
  const current = useResultSession()
  useEffect(() => {
    if (transcript) ensureResultSession(transcript, deps, local, keptCopy)
  }, [transcript, deps, local, keptCopy])
  useEffect(() => () => closeResultSession(id), [id])
  return current && current.id === id && !current.isClosed ? current : null
}

function ServerResult({ id }: { id: string }): React.JSX.Element {
  const { t } = useTranslation()
  const client = useQueryClient()
  const { component, capabilities, newTranscription } = useTranscriptionWorkspace()
  const { key, records } = useLocalHistory(component.id)
  const query = useTranscript(id)
  const writesSubtitles = Boolean(capabilities?.summaries)

  // A transcript deleted meanwhile leaves the history too, and is not brought back (T-39).
  const gone =
    query.error instanceof ApiRequestError &&
    (query.error.status === 404 || query.error.status === 410)
  // Only what was loaded since opening counts: the cache may hold an older revision (T-39). Once
  // the session is open it holds the document; later copies do not replace it.
  const fresh = query.isFetchedAfterMount && query.isSuccess ? query.data : null
  const kept = query.isError ? serverCopy(records, id) : null
  const opening = gone
    ? null
    : openingCopy({
        fresh,
        failed: query.isError && query.isFetchedAfterMount,
        kept,
        earlier: query.data ?? null
      })

  const deps = useMemo<SessionDeps>(
    () => ({
      patch: patchTranscript,
      get: (transcriptId) => getTranscript(transcriptId),
      generateSubtitle,
      optimize: (request) => optimizeSpeakers(request),
      onServerCopy: (saved) => {
        if (key) changeLocalHistory(key, (stored) => keepServerCopy(stored, saved))
        client.setQueryData(transcriptionKeys.transcript(saved.id), saved)
        client.setQueryData<TranscriptionTranscriptSummary[]>(
          transcriptionKeys.transcripts,
          (list) =>
            list?.map((entry) =>
              entry.id === saved.id
                ? {
                    ...entry,
                    title: saved.title,
                    subtitle: saved.subtitle,
                    updatedAt: saved.updatedAt,
                    expiresAt: saved.expiresAt
                  }
                : entry
            )
        )
      }
    }),
    [client, key]
  )
  const session = useOpenSession(
    id,
    opening?.transcript ?? null,
    deps,
    false,
    Boolean(opening?.fallback)
  )

  // The copy the server just answered is kept for a later transient failure (T-39).
  useEffect(() => {
    if (fresh && key) changeLocalHistory(key, (stored) => keepServerCopy(stored, fresh))
  }, [fresh, key])

  // A transcript saved a moment ago gets its AI subtitle shortly after (T-23).
  useEffect(() => {
    if (session && writesSubtitles) session.expectSubtitle()
  }, [session, writesSubtitles])

  useEffect(() => {
    if (!gone) return
    if (key) changeLocalHistory(key, (records) => withoutRecord(records, id))
    client.setQueryData<TranscriptionTranscriptSummary[]>(transcriptionKeys.transcripts, (list) =>
      list?.filter((entry) => entry.id !== id)
    )
  }, [gone, key, id, client])

  if (gone) return <NotFound onStartNew={() => void newTranscription()} />
  if (query.isError && !opening) {
    return (
      <Notice
        tone="error"
        action={
          <Button type="button" variant="outline" onClick={() => void query.refetch()}>
            {t('transcription.common.retry')}
          </Button>
        }
      >
        {t('transcription.common.loadFailed')}
      </Notice>
    )
  }
  if (!session) return <Loading />
  return <ResultWorkspace session={session} />
}

function NotFound({ onStartNew }: { onStartNew: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Notice
      tone="warning"
      action={
        <Button type="button" variant="outline" onClick={onStartNew}>
          {t('transcription.common.startNew')}
        </Button>
      }
    >
      {t('transcription.result.notFound')}
    </Notice>
  )
}

function LocalResult({ id }: { id: string }): React.JSX.Element {
  const { component, newTranscription } = useTranscriptionWorkspace()
  const { key, records } = useLocalHistory(component.id)
  const transcript = records.find((record) => record.id === id)?.transcript ?? null

  const deps = useMemo<SessionDeps>(
    () => ({
      patch: notAvailable,
      get: notAvailable,
      generateSubtitle: notAvailable,
      optimize: (request) => optimizeSpeakers(request),
      saveLocal: (changed) =>
        key !== null &&
        changeLocalHistory(key, (stored) =>
          updateRecord(stored, changed.id, (record) => ({
            ...record,
            title: changed.title,
            updatedAt: changed.updatedAt,
            transcript: changed
          }))
        )
    }),
    [key]
  )
  const session = useOpenSession(id, transcript, deps, true)

  if (!transcript) return <NotFound onStartNew={() => void newTranscription()} />
  if (!session) return <Loading />
  return <ResultWorkspace session={session} />
}

function Loading(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex justify-center py-gutter">
      <Spinner label={t('transcription.common.loading')} />
    </div>
  )
}

/**
 * The open transcript: head with title, subtitle, save state and tabs; in Preview and
 * Corrections the global player and the speaker blocks, in Export the export stream's view. It
 * publishes the document with its edits to the workspace, makes leaving wait for a running save
 * and asks before unsaved edits are dropped.
 */
function ResultWorkspace({ session }: { session: ResultSession }): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const speakerLabel = useSpeakerLabel()
  const { resultTab, setResultTab, setCurrentDocument, setBeforeLeave, capabilities } =
    useTranscriptionWorkspace()
  const state = useResultState(session)
  const blocks = useMemo(
    () => buildSpeakerBlocks(state.segments, state.speakerColors).blocks,
    [state.segments, state.speakerColors]
  )
  const player = useRef<GlobalPlayerHandle>(null)
  const [activeBlock, setActiveBlock] = useState(-1)
  const [playing, setPlaying] = useState(false)
  const [optimized, setOptimized] = useState<OptimizeResult | null>(null)
  const [leave, setLeave] = useState<{ resolve: (ok: boolean) => void } | null>(null)
  const corrections = resultTab === 'corrections'
  const { transcript } = state
  const sources = transcript.sourceFiles
  const hasAudio = sources.some((source) => source.jobId !== null)

  // The export and the summary work on what the user sees, saved or not yet.
  useEffect(() => {
    let last: { segments: unknown; speakerColors: unknown; transcript: unknown } | null = null
    const publish = (): void => {
      const current = session.getState()
      if (
        last &&
        last.segments === current.segments &&
        last.speakerColors === current.speakerColors &&
        last.transcript === current.transcript
      ) {
        return
      }
      last = current
      const speakerColors = buildSpeakerBlocks(
        current.segments,
        current.speakerColors
      ).speakerColors
      setCurrentDocument({
        transcript: {
          ...current.transcript,
          segments: current.segments,
          speakerColors,
          text: buildTranscriptText(current.segments) || current.transcript.text
        },
        segments: current.segments,
        speakerColors
      })
    }
    publish()
    return session.subscribe(publish)
  }, [session, setCurrentDocument])

  // Leaving waits for a running save; unsaved edits are only dropped when the user agrees (T-35).
  useEffect(() => {
    setBeforeLeave(async () => {
      await session.flush()
      if (!session.hasUnsavedChanges()) return true
      return new Promise<boolean>((resolve) => setLeave({ resolve }))
    })
    return () => setBeforeLeave(null)
  }, [session, setBeforeLeave])

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (session.hasUnsavedChanges()) event.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [session])

  // The playing block stays in view (T-24).
  useEffect(() => {
    if (playing && activeBlock >= 0) scrollToBlock(activeBlock)
  }, [activeBlock, playing])

  const onTime = useCallback((time: number) => setActiveBlock(blockAt(blocks, time)), [blocks])

  const answerLeave = (ok: boolean): void => {
    leave?.resolve(ok)
    setLeave(null)
  }

  const download = (): void => {
    const shown = blocks.filter((block) => !state.hidden.has(block.speaker))
    const text =
      shown
        .map(
          (block) =>
            `${speakerLabel(block.speaker)} • [${formatTimestamp(block.start)}]\n${blockCopyText(
              state.segments,
              block,
              t('transcription.result.emptySpeakerHint')
            )}`
        )
        .join('\n\n') || transcript.text
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `transkription-${transcript.id}.txt`
    link.click()
    URL.revokeObjectURL(url)
  }

  const optimize = async (): Promise<void> => {
    setOptimized(await session.optimizeSpeakers())
  }

  return (
    <section className="flex min-w-0 flex-col gap-stack-lg">
      <ResultHeader
        session={session}
        state={state}
        tab={resultTab}
        onTab={setResultTab}
        onDownload={resultTab === 'export' ? null : download}
        canGenerateSubtitle={Boolean(capabilities?.summaries)}
      />
      {state.keptCopy ? (
        <Notice tone="warning">{t('transcription.result.offlineCopy')}</Notice>
      ) : null}
      {transcript.expiresAt && !state.local ? (
        <Notice tone="info">
          {t('transcription.result.retentionNotice', {
            date: formatExpiry(transcript.expiresAt, i18n.language)
          })}
        </Notice>
      ) : null}
      {state.saveStatus === 'failed' ? (
        <Notice
          tone="error"
          action={
            <Button type="button" variant="outline" onClick={() => session.retry()}>
              {t('transcription.common.retry')}
            </Button>
          }
        >
          {state.local
            ? t('transcription.result.localSaveFailed')
            : t('transcription.result.saveFailed')}
        </Notice>
      ) : null}
      {state.saveStatus === 'conflict' ? (
        <Notice
          tone="warning"
          action={
            <span className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={() => void session.reload()}>
                {t('transcription.result.conflictReload')}
              </Button>
              <Button type="button" variant="outline" onClick={() => void session.overwrite()}>
                {t('transcription.result.conflictOverwrite')}
              </Button>
            </span>
          }
        >
          {t('transcription.result.saveConflict')}
        </Notice>
      ) : null}
      {resultTab === 'export' ? (
        <ExportView />
      ) : (
        <>
          <Card>
            <CardContent className="flex flex-col gap-stack-md">
              <div className="flex flex-wrap items-center gap-2">
                <p className="m-0">
                  {`${t('transcription.result.aiTranscriptLabel')} | ${
                    corrections
                      ? t('transcription.result.correctionMode')
                      : t('transcription.common.preview')
                  }`}
                </p>
                {corrections ? (
                  <div className="ml-auto flex items-center gap-1">
                    <IconButton
                      label={t('transcription.result.undoAction')}
                      disabled={state.undo.length === 0}
                      onClick={() => session.undo()}
                    >
                      <Undo2Icon aria-hidden="true" className="size-4" />
                    </IconButton>
                    {capabilities?.speakerOptimization ? (
                      <IconButton
                        label={
                          state.optimizing
                            ? t('transcription.result.speakerOptimizationRunning')
                            : t('transcription.result.optimizeSpeakersAI')
                        }
                        disabled={state.optimizing || state.segments.length === 0}
                        aria-busy={state.optimizing || undefined}
                        onClick={() => void optimize()}
                      >
                        {state.optimizing ? (
                          <Spinner
                            size="sm"
                            label={t('transcription.result.speakerOptimizationRunning')}
                          />
                        ) : (
                          <WandSparklesIcon aria-hidden="true" className="size-4" />
                        )}
                      </IconButton>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <GlobalPlayer
                sources={sources}
                blocks={blocks}
                total={totalDuration(sources, blocks, transcript.duration)}
                onTime={onTime}
                onPlayingChange={setPlaying}
                ref={player}
              />
            </CardContent>
          </Card>
          <Transcript
            key={corrections ? 'corrections' : 'preview'}
            session={session}
            state={state}
            blocks={blocks}
            corrections={corrections}
            activeBlock={activeBlock}
            playing={playing}
            hasAudio={hasAudio}
            player={player}
          />
          <p className="m-0 text-center">{t('transcription.common.accuracyWarning')}</p>
        </>
      )}

      <Dialog
        open={optimized !== null}
        onOpenChange={(open) => (open ? undefined : setOptimized(null))}
      >
        <DialogContent closeLabel={t('transcription.common.close')}>
          <DialogHeader>
            <DialogTitle>
              {optimized?.ok ? t('transcription.common.success') : t('transcription.common.error')}
            </DialogTitle>
            <DialogDescription>
              {optimized?.ok
                ? t('transcription.result.speakerOptimizationSuccess')
                : `${t('transcription.result.speakerOptimizationError')}${
                    optimized?.message ?? t('transcription.result.speakerOptimizationUnknownError')
                  }`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" onClick={() => setOptimized(null)}>
              {t('transcription.common.close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={leave !== null}
        onOpenChange={(open) => (open ? undefined : answerLeave(false))}
      >
        <DialogContent closeLabel={t('transcription.common.close')}>
          <DialogHeader>
            <DialogTitle>{t('transcription.result.leaveTitle')}</DialogTitle>
            <DialogDescription>{t('transcription.result.leaveDescription')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => answerLeave(false)}>
              {t('transcription.common.cancel')}
            </Button>
            <Button type="button" variant="destructive" onClick={() => answerLeave(true)}>
              {t('transcription.result.leaveDiscard')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
