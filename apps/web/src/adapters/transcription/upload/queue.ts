import type { TranscriptionJobStatus, TranscriptionResult } from '@justcampus/shared'
import type { VoiceDraft } from '../mapping/speakers'

/**
 * The upload queue as kiChat keeps it (`selectedFileGroups`): transcript groups of files, each
 * group saved as one transcript (T-06). Plain data and pure changes; `UploadQueue` in `store.ts`
 * runs the uploads, analyses and transcriptions on it.
 */

/** Where a file stands. */
export type FilePhase =
  /** Added, its upload not started yet. */
  | 'idle'
  /** Creating the job and uploading the bytes. */
  | 'uploading'
  /** The server analyses the voices. */
  | 'analyzing'
  /** Analysed, waiting for the start. */
  | 'ready'
  /** Session, upload or analysis failed. */
  | 'analysisFailed'
  /** Dispatched; the server transcribes. */
  | 'transcribing'
  /** Its result is here (and kept for a retry of the group). */
  | 'completed'
  /** The transcription failed; the next start tries again. */
  | 'failed'

/** The row's look, as kiChat's `is-ready`, `is-processing`, `is-error`, `is-success`. */
export type RowTone = 'ready' | 'processing' | 'error' | 'success'

/** The row's status line; `common.*` and `upload.*` texts of the same name. */
export type StatusKey =
  | 'ready'
  | 'creatingSession'
  | 'uploadingFile'
  | 'analyzingAudio'
  | 'analyzingSpeakers'
  | 'waitingForAnalysis'
  | 'readyForTranscription'
  | 'preprocessing'
  | 'preparing'
  | 'transcribing'
  | 'speakerAssignment'
  | 'inProgress'
  | 'transcriptionComplete'
  | 'readyFromCache'
  | 'done'
  | 'failed'

/** Why a file failed, as kiChat's messages tell it (T-16). */
export type ErrorKey =
  | 'uploadSessionFailed'
  | 's3UploadFailed'
  | 's3UploadNetworkError'
  | 'uploadAborted'
  | 'analysisJobStartFailed'
  | 'analysisError'
  | 'processingJobStartFailed'
  | 'transcriptionError'
  | 'fileProcessingFailed'
  | 'noServerResponse'

export interface FileError {
  key: ErrorKey
  /** The storage's HTTP status (`s3UploadFailed`). */
  status?: number | null
  /** The server's detail, e.g. the diarisation's error; possibly German. */
  message?: string | null
}

export interface QueueFile {
  /** Local id of the row. */
  id: string
  name: string
  /** Bytes; a restored job has the server's count, kiChat had 0 (T-15). */
  size: number
  lastModified: number | null
  mimeType: string
  /** The local file; `null` for a job restored after a reload. */
  file: File | null
  restored: boolean
  /** Seconds, measured in the browser or by the server. */
  duration: number | null
  jobId: string | null
  /** The job's status as last seen. */
  jobStatus: TranscriptionJobStatus | null
  /** Whether storage has the bytes. */
  uploaded: boolean
  phase: FilePhase
  /** 0 to 100; an estimate while the server reports none (T-11). */
  progress: number
  tone: RowTone
  status: StatusKey
  error: FileError | null
  /** The analysed voices with the names given; `null` before the analysis. */
  voices: VoiceDraft[] | null
  /** Whether the mapping dialog saved them (kiChat's `speakersSaved`). */
  voicesSaved: boolean
  /** The finished transcription, kept for a retry of its group (T-13). */
  result: TranscriptionResult | null
}

/** The transcript a group was saved as (kiChat's `processedTranscripts`). */
export interface SavedTranscript {
  id: string
  title: string
  revision: number
}

export interface QueueGroup {
  id: string
  name: string
  files: QueueFile[]
  /** Sent with the save, so a repeated save answers the first one. */
  idempotencyKey: string
  saved: SavedTranscript | null
  saveFailed: boolean
}

export interface QueueState {
  groups: QueueGroup[]
  /** A start runs (kiChat's `isProcessing`): the queue takes no files and nothing moves. */
  processing: boolean
}

export const EMPTY_QUEUE: QueueState = { groups: [], processing: false }

/** kiChat's group names: `Transcript 1`, `Transcript 2`, … in both languages. */
export function defaultGroupName(index: number): string {
  return `Transcript ${index + 1}`
}

/** Names `renumberGroups` treats as numbered defaults rather than names the user gave. */
const NUMBERED_NAME = /^(Gruppe|Transkript|Transcript) \d+$/i

export function newGroup(index: number, name: string = defaultGroupName(index)): QueueGroup {
  return {
    id: crypto.randomUUID(),
    name,
    files: [],
    idempotencyKey: crypto.randomUUID(),
    saved: null,
    saveFailed: false
  }
}

/** kiChat's `renumberGroups`: default names follow the group's place; other names stay. */
export function renumberGroups(groups: readonly QueueGroup[]): QueueGroup[] {
  return groups.map((group, index) => {
    const name = group.name.trim()
    if (name !== '' && !NUMBERED_NAME.test(name)) return group
    const numbered = defaultGroupName(index)
    return group.name === numbered ? group : { ...group, name: numbered }
  })
}

/** kiChat's `cleanupEmptyGroups`: drops groups without files, then renumbers. */
export function cleanupEmptyGroups(groups: readonly QueueGroup[]): QueueGroup[] {
  return renumberGroups(groups.filter((group) => group.files.length > 0))
}

/** The name a restored job's group gets: its filename without extension (T-15). */
export function restoredGroupName(filename: string): string {
  return filename.replace(/\.[^.]+$/, '') || filename
}

/** kiChat's duplicate identity within a group: name, byte size and last change (T-05). */
export function duplicateKey(file: {
  name: string
  size: number
  lastModified: number | null
}): string {
  return `${file.name}_${file.size}_${file.lastModified ?? ''}`
}

/** A queue row for a local file, before anything is uploaded. */
export function queueFileFrom(file: File): QueueFile {
  return {
    id: crypto.randomUUID(),
    name: file.name,
    size: file.size,
    lastModified: file.lastModified,
    mimeType: file.type,
    file,
    restored: false,
    duration: null,
    jobId: null,
    jobStatus: null,
    uploaded: false,
    phase: 'idle',
    progress: 0,
    tone: 'ready',
    status: 'ready',
    error: null,
    voices: null,
    voicesSaved: false,
    result: null
  }
}

/**
 * Adds files to a group, creating it with the next default name if it is not there (kiChat's
 * `handleFileSelect`). Files that are already in the group (same name, size and last change) are
 * left out; the others are added after the group's files. Returns the rows really added.
 */
export function addToGroup(
  groups: readonly QueueGroup[],
  groupIndex: number,
  files: readonly QueueFile[]
): { groups: QueueGroup[]; added: QueueFile[] } {
  const next = [...groups]
  while (next.length <= groupIndex) next.push(newGroup(next.length))
  const group = next[groupIndex]!
  const keys = new Set(group.files.map(duplicateKey))
  const added: QueueFile[] = []
  for (const file of files) {
    const key = duplicateKey(file)
    if (keys.has(key)) continue
    keys.add(key)
    added.push(file)
  }
  next[groupIndex] = { ...group, files: [...group.files, ...added] }
  return { groups: next, added }
}

/**
 * The group files dropped on the page go to: the first group still empty, else the first not yet
 * saved, else a new one at the end. kiChat always took the first group, saved or not.
 */
export function dropTargetIndex(groups: readonly QueueGroup[]): number {
  const empty = groups.findIndex((group) => group.saved === null && group.files.length === 0)
  if (empty >= 0) return empty
  const open = groups.findIndex((group) => group.saved === null)
  return open >= 0 ? open : groups.length
}

/** Where a file is: its group's and its own index. */
export interface FilePosition {
  groupIndex: number
  fileIndex: number
}

export function findFile(
  groups: readonly QueueGroup[],
  fileId: string
): (FilePosition & { group: QueueGroup; file: QueueFile }) | null {
  for (const [groupIndex, group] of groups.entries()) {
    const fileIndex = group.files.findIndex((file) => file.id === fileId)
    if (fileIndex >= 0) return { groupIndex, fileIndex, group, file: group.files[fileIndex]! }
  }
  return null
}

export function findFileByJob(groups: readonly QueueGroup[], jobId: string): QueueFile | null {
  for (const group of groups) {
    const file = group.files.find((candidate) => candidate.jobId === jobId)
    if (file) return file
  }
  return null
}

/** Changes one file; the other groups and files stay the same objects. */
export function updateFile(
  groups: readonly QueueGroup[],
  fileId: string,
  change: Partial<QueueFile> | ((file: QueueFile) => Partial<QueueFile>)
): QueueGroup[] {
  return groups.map((group) => {
    if (!group.files.some((file) => file.id === fileId)) return group
    return {
      ...group,
      files: group.files.map((file) =>
        file.id === fileId
          ? { ...file, ...(typeof change === 'function' ? change(file) : change) }
          : file
      )
    }
  })
}

export function updateGroup(
  groups: readonly QueueGroup[],
  groupId: string,
  change: Partial<QueueGroup>
): QueueGroup[] {
  return groups.map((group) => (group.id === groupId ? { ...group, ...change } : group))
}

/** Removes a file and then the groups left empty (kiChat's `removeFileFromGroup`). */
export function removeFile(groups: readonly QueueGroup[], fileId: string): QueueGroup[] {
  return cleanupEmptyGroups(
    groups.map((group) => ({ ...group, files: group.files.filter((file) => file.id !== fileId) }))
  )
}

/** Removes a group and renumbers the others (kiChat's `removeGroup`). */
export function removeGroup(groups: readonly QueueGroup[], groupId: string): QueueGroup[] {
  return renumberGroups(groups.filter((group) => group.id !== groupId))
}

/**
 * kiChat's `moveFile`: takes a file out of its group and puts it into a group at `toFileIndex`, or
 * at the end. Saved groups give and take nothing (T-07); the queue stays as it is then.
 */
export function moveFile(
  groups: readonly QueueGroup[],
  from: FilePosition,
  toGroupIndex: number,
  toFileIndex: number | null = null
): QueueGroup[] {
  const source = groups[from.groupIndex]
  const target = groups[toGroupIndex]
  if (!source || !target || source.saved || target.saved) return [...groups]
  const moved = source.files[from.fileIndex]
  if (!moved) return [...groups]
  const next = groups.map((group) => ({ ...group, files: [...group.files] }))
  next[from.groupIndex]!.files.splice(from.fileIndex, 1)
  const targetFiles = next[toGroupIndex]!.files
  const index =
    toFileIndex === null || Number.isNaN(toFileIndex)
      ? targetFiles.length
      : Math.max(0, Math.min(toFileIndex, targetFiles.length))
  targetFiles.splice(index, 0, moved)
  return next
}

/** Every file of the queue, in order. */
export function allFiles(groups: readonly QueueGroup[]): QueueFile[] {
  return groups.flatMap((group) => group.files)
}

/** Bytes of all files, for kiChat's `Dateigröße: … MB gesamt`. */
export function totalBytes(groups: readonly QueueGroup[]): number {
  return allFiles(groups).reduce((sum, file) => sum + file.size, 0)
}

/** Whether a group may change: not while a start runs, not once saved (T-07, T-11). */
export function groupLocked(state: QueueState, group: QueueGroup): boolean {
  return state.processing || group.saved !== null
}

/** Whether a file still waits for its upload or analysis. */
export function analysisPending(file: QueueFile): boolean {
  return file.phase === 'idle' || file.phase === 'uploading' || file.phase === 'analyzing'
}
