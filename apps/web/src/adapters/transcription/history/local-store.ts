import { useCallback, useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import {
  TRANSCRIPTION_SUBTITLE_SOURCES,
  transcriptionSegmentSchema,
  transcriptionSourceFileSchema,
  transcriptionSpeakerColorMapSchema,
  transcriptionTranscriptCreateSchema,
  transcriptionWordSchema,
  type TranscriptionSegment,
  type TranscriptionTranscript,
  type TranscriptionTranscriptCreate,
  type TranscriptionTranscriptSummary
} from '@justcampus/shared'
import { meQuery } from '@/lib/queries'
import { buildTranscriptText } from '../segments/text'
import type { HistoryEntry } from './model'

/**
 * kiChat's local history (`transcriptionHistory` in `localStorage`, T-39), scoped here to the
 * module and the signed-in user so a shared browser never shows one user's list to another. It
 * keeps the titles and dates of the server's list, the last opened server transcripts as a
 * fallback for a transient failure, and whole transcripts that only this browser has (a save that
 * did not reach the server). No audio is stored.
 */

/** Ids of transcripts only this browser has. */
export const LOCAL_ID_PREFIX = 'local-'

export function isLocalTranscriptId(id: string): boolean {
  return id.startsWith(LOCAL_ID_PREFIX)
}

export interface LocalHistoryRecord extends HistoryEntry {
  /** The transcript itself, for records only this browser has; else `null`. */
  transcript: TranscriptionTranscript | null
}

/** kiChat's key; Campus adds `:<module>:<user>`. */
const LOCAL_HISTORY_KEY = 'transcriptionHistory'

export function localHistoryKey(componentId: string, userId: string): string {
  return `${LOCAL_HISTORY_KEY}:${componentId}:${userId}`
}

/** Segments as kiChat stored them: an array, or the array as a JSON string; anything else none. */
export function normalizeSegments(raw: unknown): TranscriptionSegment[] {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return []
    }
  }
  if (!Array.isArray(value)) return []
  const parsed = z.array(transcriptionSegmentSchema).safeParse(value)
  return parsed.success ? parsed.data : []
}

const stringOrNull = z.string().nullable().catch(null)

/** A stored transcript; kiChat's records lack most details, which then take their defaults. */
const storedTranscriptSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    subtitle: stringOrNull,
    language: stringOrNull,
    duration: z.number().nullable().catch(null),
    originalFilename: stringOrNull,
    createdAt: z.string(),
    updatedAt: z.string(),
    segments: z.unknown(),
    words: z.array(transcriptionWordSchema).catch([]),
    text: z.string().catch(''),
    sourceFiles: z.array(transcriptionSourceFileSchema).catch([]),
    speakerColors: transcriptionSpeakerColorMapSchema.catch({}),
    subtitleSource: z.enum(TRANSCRIPTION_SUBTITLE_SOURCES).nullable().catch(null),
    model: stringOrNull,
    provider: stringOrNull,
    fileSize: z.number().int().min(0).nullable().catch(null),
    summaryTemplateId: stringOrNull,
    revision: z.number().int().min(1).catch(1),
    expiresAt: stringOrNull
  })
  .transform((stored): TranscriptionTranscript => ({
    ...stored,
    segments: normalizeSegments(stored.segments)
  }))

const recordSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  createdAt: stringOrNull,
  updatedAt: stringOrNull,
  local: z.boolean().catch(false),
  transcript: storedTranscriptSchema.nullable().catch(null)
})

/** The records in a stored value; broken ones are dropped, and local ones without a transcript. */
export function parseLocalHistory(raw: string | null): LocalHistoryRecord[] {
  if (!raw) return []
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(value)) return []
  const records: LocalHistoryRecord[] = []
  for (const item of value) {
    const parsed = recordSchema.safeParse(item)
    if (!parsed.success) continue
    if (parsed.data.local && !parsed.data.transcript) continue
    records.push(parsed.data)
  }
  return records
}

/**
 * The records after a successful server list: its entries replace the ones from the server (a
 * kept copy of one still listed stays), the records only this browser has stay.
 */
export function syncLocalHistory(
  records: readonly LocalHistoryRecord[],
  server: readonly TranscriptionTranscriptSummary[]
): LocalHistoryRecord[] {
  const kept = new Map(
    records.filter((record) => !record.local).map((record) => [record.id, record.transcript])
  )
  return [
    ...server.map((summary) => ({
      id: summary.id,
      title: summary.title,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      local: false,
      transcript: kept.get(summary.id) ?? null
    })),
    ...records.filter((record) => record.local)
  ]
}

/** Server transcripts this browser keeps a copy of at most, the last ones opened or saved. */
export const KEPT_SERVER_COPIES = 5

/**
 * The records with the copy of a server transcript kept (T-39), so a transient failure can still
 * open it: its record gets the copy and comes first, and only the newest `KEPT_SERVER_COPIES`
 * copies stay. The server stays authoritative; the copy is only read when it cannot answer.
 */
export function keepServerCopy(
  records: readonly LocalHistoryRecord[],
  transcript: TranscriptionTranscript
): LocalHistoryRecord[] {
  const record: LocalHistoryRecord = {
    id: transcript.id,
    title: transcript.title,
    createdAt: transcript.createdAt,
    updatedAt: transcript.updatedAt,
    local: false,
    transcript
  }
  let copies = 1
  return [
    record,
    ...records
      .filter((other) => other.id !== transcript.id)
      .map((other) => {
        if (other.local || !other.transcript) return other
        copies++
        return copies > KEPT_SERVER_COPIES ? { ...other, transcript: null } : other
      })
  ]
}

/** The kept copy of a server transcript, if any. */
export function serverCopy(
  records: readonly LocalHistoryRecord[],
  id: string
): TranscriptionTranscript | null {
  return records.find((record) => record.id === id && !record.local)?.transcript ?? null
}

/** The id of the local copy of a save that failed: one per idempotency key, never two. */
export function localIdFor(idempotencyKey: string): string {
  return `${LOCAL_ID_PREFIX}${idempotencyKey}`
}

/**
 * A transcript only this browser has, made from a save the server did not take (T-39, kiChat's
 * `saveTranscriptToHistory` without a slug): the group's segments, words, sources and colours
 * under its title.
 */
export function localTranscriptFromCreate(
  input: TranscriptionTranscriptCreate,
  now: Date
): TranscriptionTranscript {
  const parsed = transcriptionTranscriptCreateSchema.safeParse(input)
  const segments = parsed.success ? parsed.data.segments : normalizeSegments(input.segments)
  const sourceFiles = parsed.success ? parsed.data.sourceFiles : []
  const at = now.toISOString()
  return {
    id: localIdFor(input.idempotencyKey),
    title: input.title,
    subtitle: null,
    subtitleSource: null,
    language: input.language ?? null,
    duration: input.duration ?? null,
    originalFilename: sourceFiles[0]?.name ?? null,
    createdAt: at,
    updatedAt: at,
    expiresAt: null,
    model: null,
    provider: null,
    fileSize: null,
    text: buildTranscriptText(segments),
    segments,
    words: parsed.success ? parsed.data.words : [],
    sourceFiles,
    speakerColors: parsed.success ? parsed.data.speakerColors : {},
    summaryTemplateId: null,
    revision: 1
  }
}

/**
 * The records after a save of a new transcript: a failed one is kept as a transcript only this
 * browser has (once per idempotency key, an earlier copy stays as it is); once a retry reached the
 * server, that copy goes again, unless the user changed it meanwhile.
 */
export function recordSaveOutcome(
  records: readonly LocalHistoryRecord[],
  outcome:
    | { input: TranscriptionTranscriptCreate; transcript: TranscriptionTranscript }
    | { input: TranscriptionTranscriptCreate; error: unknown },
  now: Date
): LocalHistoryRecord[] {
  const id = localIdFor(outcome.input.idempotencyKey)
  const existing = records.find((record) => record.id === id)
  if ('transcript' in outcome) {
    const copy = existing?.transcript
    if (!existing || (copy && copy.updatedAt !== copy.createdAt)) return [...records]
    return withoutRecord(records, id)
  }
  if (existing) return [...records]
  return [localRecord(localTranscriptFromCreate(outcome.input, now)), ...records]
}

export function withoutRecord(
  records: readonly LocalHistoryRecord[],
  id: string
): LocalHistoryRecord[] {
  return records.filter((record) => record.id !== id)
}

/** The records with one changed; unknown ids change nothing. */
export function updateRecord(
  records: readonly LocalHistoryRecord[],
  id: string,
  change: (record: LocalHistoryRecord) => LocalHistoryRecord
): LocalHistoryRecord[] {
  return records.map((record) => (record.id === id ? change(record) : record))
}

/** A record of a transcript only this browser has, newest first in the list. */
export function localRecord(transcript: TranscriptionTranscript): LocalHistoryRecord {
  return {
    id: transcript.id,
    title: transcript.title,
    createdAt: transcript.createdAt,
    updatedAt: transcript.updatedAt,
    local: true,
    transcript
  }
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const listeners = new Set<() => void>()
const cache = new Map<string, { raw: string | null; records: LocalHistoryRecord[] }>()

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

/** The records stored under a key; the same array while the stored value does not change. */
export function readLocalHistory(key: string): LocalHistoryRecord[] {
  let raw: string | null = null
  try {
    raw = storage()?.getItem(key) ?? null
  } catch {
    raw = null
  }
  const cached = cache.get(key)
  if (cached && cached.raw === raw) return cached.records
  const records = parseLocalHistory(raw)
  cache.set(key, { raw, records })
  return records
}

/**
 * Stores the records (none removes the key) and tells every reader. When the storage is full the
 * kept copies of server transcripts go first; beyond that, full storage is ignored.
 */
export function writeLocalHistory(key: string, records: readonly LocalHistoryRecord[]): void {
  const attempts = [
    records,
    records.map((record) => (record.local ? record : { ...record, transcript: null }))
  ]
  for (const attempt of attempts) {
    try {
      if (attempt.length === 0) storage()?.removeItem(key)
      else storage()?.setItem(key, JSON.stringify(attempt))
      break
    } catch {
      // Quota or privacy mode: try without the copies; the server's list stays authoritative.
    }
  }
  listeners.forEach((listener) => listener())
}

/** Removes every user's local history of every module, on sign-out, and tells every reader. */
export function clearLocalHistories(): void {
  const stored = storage()
  if (!stored) return
  try {
    const keys: string[] = []
    for (let index = 0; index < stored.length; index++) {
      const key = stored.key(index)
      if (key?.startsWith(`${LOCAL_HISTORY_KEY}:`)) keys.push(key)
    }
    for (const key of keys) stored.removeItem(key)
  } catch {
    // Blocked storage holds nothing to clear.
  }
  cache.clear()
  listeners.forEach((listener) => listener())
}

/** Changes the records stored under a key. */
export function changeLocalHistory(
  key: string,
  change: (records: LocalHistoryRecord[]) => LocalHistoryRecord[]
): void {
  writeLocalHistory(key, change(readLocalHistory(key)))
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (event: StorageEvent): void => {
    if (event.key === null || event.key.startsWith(`${LOCAL_HISTORY_KEY}:`)) listener()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

const EMPTY: LocalHistoryRecord[] = []

/**
 * The signed-in user's local history of a module, and its storage key (`null` until the user is
 * known, when there are no records).
 */
export function useLocalHistory(componentId: string): {
  key: string | null
  records: LocalHistoryRecord[]
} {
  const userId = useQuery(meQuery).data?.id ?? null
  const key = userId ? localHistoryKey(componentId, userId) : null
  const snapshot = useCallback(() => (key ? readLocalHistory(key) : EMPTY), [key])
  const records = useSyncExternalStore(subscribe, snapshot, () => EMPTY)
  return { key, records }
}
