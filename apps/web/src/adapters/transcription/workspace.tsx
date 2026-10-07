import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import type {
  TranscriptionCapabilities,
  TranscriptionJobSettings,
  TranscriptionSegment,
  TranscriptionSpeakerColorMap,
  TranscriptionTranscript
} from '@justcampus/shared'
import type { ComponentOf } from '../types'
import { useTranscriptionCapabilities } from './api'
import { useMemoryCell, usePageMemory, type PageMemory } from './page-memory'
import { WorkspaceContext } from './use-workspace'

/**
 * What the work area shows (T-01): the entry choice, the upload queue, regular recording, live
 * transcription, or a saved transcript.
 */
export const TRANSCRIPTION_VIEWS = ['choice', 'upload', 'record', 'live', 'result'] as const
export type TranscriptionView = (typeof TRANSCRIPTION_VIEWS)[number]

/** The tabs of a saved transcript (T-22). */
export const RESULT_TABS = ['preview', 'corrections', 'export'] as const
export type ResultTab = (typeof RESULT_TABS)[number]

/** Language, speaker count and correction for new uploads (T-09). */
export type UploadSettings = TranscriptionJobSettings

const FALLBACK_UPLOAD_SETTINGS: UploadSettings = {
  language: 'auto',
  speakerCount: 'auto',
  llmCorrection: true
}

/** Hears that storage has a handed-over file's bytes; a failed upload says nothing. */
export type UploadStored = (file: File) => void

/** Files handed to the upload queue from elsewhere, e.g. recorded takes (T-58). */
export interface PendingUpload {
  id: string
  files: File[]
  /** Name of the group they form; `null`: the queue's next `Transcript n`. */
  title: string | null
  onStored?: UploadStored
}

export interface EnqueueOptions {
  title?: string | null
  /** Hears when each file is stored, e.g. to keep a recorded take's backup until then. */
  onStored?: UploadStored
}

/**
 * The transcript open in the result workspace with the edits made to it, so the export and the
 * summary work on what the user sees, saved or not yet.
 */
export interface TranscriptDocument {
  transcript: TranscriptionTranscript
  segments: TranscriptionSegment[]
  speakerColors: TranscriptionSpeakerColorMap
}

/**
 * Asked before the workspace leaves the open transcript; `false` stays. The result workspace uses
 * it to finish a running save first (T-35).
 */
export type BeforeLeave = () => boolean | Promise<boolean>

export interface TranscriptionWorkspace {
  component: ComponentOf<'transcription'>
  /** What the page keeps across a remount of itself (see `page-memory.ts`). */
  memory: PageMemory
  /** `undefined` while loading or when the module does not answer. */
  capabilities: TranscriptionCapabilities | undefined
  view: TranscriptionView
  setView: (view: TranscriptionView) => void
  /** The saved transcript the result view shows. */
  transcriptId: string | null
  /** Shows a saved transcript, after `beforeLeave` agreed. */
  openTranscript: (id: string) => Promise<void>
  /**
   * Back to the entry choice without a transcript and with an empty history search (T-01), after
   * `beforeLeave` agreed.
   */
  newTranscription: () => Promise<void>
  resultTab: ResultTab
  setResultTab: (tab: ResultTab) => void
  uploadSettings: UploadSettings
  setUploadSettings: (change: Partial<UploadSettings>) => void
  historySearch: string
  setHistorySearch: (search: string) => void
  currentDocument: TranscriptDocument | null
  setCurrentDocument: (document: TranscriptDocument | null) => void
  /** Registers the check before leaving the open transcript; `null` removes it. */
  setBeforeLeave: (check: BeforeLeave | null) => void
  /** Files waiting for the upload queue, oldest first. */
  pendingUploads: readonly PendingUpload[]
  /** Hands files to the upload queue as one group and shows it. */
  enqueueUpload: (files: File[], options?: EnqueueOptions) => void
  /** Takes the waiting files out; the upload queue calls it when it adds them. */
  takePendingUploads: () => PendingUpload[]
}

interface WorkspaceProviderProps {
  component: ComponentOf<'transcription'>
  children: ReactNode
}

/**
 * The state the areas of the transcription page share (`useTranscriptionWorkspace`); it lives as
 * long as the page.
 */
export function TranscriptionWorkspaceProvider({
  component,
  children
}: WorkspaceProviderProps): React.JSX.Element {
  const capabilities = useTranscriptionCapabilities().data
  const memory = usePageMemory(component.id)
  const [view, setView] = useMemoryCell(
    memory.cell<TranscriptionView>('workspace.view', () => 'choice')
  )
  const [transcriptId, setTranscriptId] = useMemoryCell(
    memory.cell<string | null>('workspace.transcriptId', () => null)
  )
  const [resultTab, setResultTab] = useMemoryCell(
    memory.cell<ResultTab>('workspace.resultTab', () => 'preview')
  )
  const [settingsChange, setSettingsChange] = useMemoryCell(
    memory.cell<Partial<UploadSettings>>('workspace.uploadSettings', () => ({}))
  )
  const [historySearch, setHistorySearch] = useMemoryCell(
    memory.cell('workspace.historySearch', () => '')
  )
  const [currentDocument, setCurrentDocument] = useState<TranscriptDocument | null>(null)
  const pendingCell = memory.cell<PendingUpload[]>('workspace.pendingUploads', () => [])
  const [pendingUploads, setPendingUploads] = useMemoryCell(pendingCell)
  const beforeLeave = useRef<BeforeLeave | null>(null)

  const mayLeave = useCallback(async (): Promise<boolean> => {
    const check = beforeLeave.current
    return check ? await check() : true
  }, [])

  const openTranscript = useCallback(
    async (id: string): Promise<void> => {
      if (id === transcriptId && view === 'result') return
      if (!(await mayLeave())) return
      setCurrentDocument(null)
      setTranscriptId(id)
      setResultTab('preview')
      setView('result')
    },
    [mayLeave, setResultTab, setTranscriptId, setView, transcriptId, view]
  )

  const newTranscription = useCallback(async (): Promise<void> => {
    if (!(await mayLeave())) return
    setCurrentDocument(null)
    setTranscriptId(null)
    setResultTab('preview')
    setHistorySearch('')
    setView('choice')
  }, [mayLeave, setHistorySearch, setResultTab, setTranscriptId, setView])

  const enqueueUpload = useCallback(
    (files: File[], { title = null, onStored }: EnqueueOptions = {}) => {
      if (files.length === 0) return
      setPendingUploads((current) => [
        ...current,
        { id: crypto.randomUUID(), files, title, onStored }
      ])
      setView('upload')
    },
    [setPendingUploads, setView]
  )

  const takePendingUploads = useCallback((): PendingUpload[] => {
    const taken = pendingCell.value
    if (taken.length > 0) setPendingUploads([])
    return taken
  }, [pendingCell, setPendingUploads])

  const setUploadSettings = useCallback(
    (change: Partial<UploadSettings>) => {
      setSettingsChange((current) => ({ ...current, ...change }))
    },
    [setSettingsChange]
  )

  const setBeforeLeave = useCallback((check: BeforeLeave | null) => {
    beforeLeave.current = check
  }, [])

  // The admin's defaults until the user changes a setting; correction only where it is offered.
  const defaults = capabilities?.defaults ?? FALLBACK_UPLOAD_SETTINGS
  const uploadSettings = useMemo<UploadSettings>(() => {
    const settings = { ...defaults, ...settingsChange }
    return capabilities && !capabilities.llmCorrection
      ? { ...settings, llmCorrection: false }
      : settings
  }, [capabilities, defaults, settingsChange])

  const workspace = useMemo<TranscriptionWorkspace>(
    () => ({
      component,
      memory,
      capabilities,
      view,
      setView,
      transcriptId,
      openTranscript,
      newTranscription,
      resultTab,
      setResultTab,
      uploadSettings,
      setUploadSettings,
      historySearch,
      setHistorySearch,
      currentDocument,
      setCurrentDocument,
      setBeforeLeave,
      pendingUploads,
      enqueueUpload,
      takePendingUploads
    }),
    [
      component,
      memory,
      capabilities,
      view,
      setView,
      transcriptId,
      openTranscript,
      newTranscription,
      resultTab,
      setResultTab,
      uploadSettings,
      setUploadSettings,
      historySearch,
      setHistorySearch,
      currentDocument,
      setBeforeLeave,
      pendingUploads,
      enqueueUpload,
      takePendingUploads
    ]
  )

  return <WorkspaceContext.Provider value={workspace}>{children}</WorkspaceContext.Provider>
}
