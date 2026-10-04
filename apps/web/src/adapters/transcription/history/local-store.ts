import { useCallback, useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import {
  transcriptionSegmentSchema,
  transcriptionSourceFileSchema,
  transcriptionSpeakerColorMapSchema,
  transcriptionWordSchema,
  type TranscriptionSegment,
  type TranscriptionTranscript,
  type TranscriptionTranscriptSummary
} from '@justcampus/shared'
import { meQuery } from '@/lib/queries'
import type { HistoryEntry } from './model'

/**
 * kiChat's local history (`transcriptionHistory` in `localStorage`, T-39), scoped here to the
 * module and the signed-in user so a shared browser never shows one user's list to another. It
 * keeps the titles and dates of the server's list, for a transient failure, and whole transcripts
 * that only this browser has (a save that did not reach the server). No audio is stored.
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

export function localHistoryKey(componentId: string, userId: string): string {
  return `transcriptionHistory:${componentId}:${userId}`
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
    speakerColors: transcriptionSpeakerColorMapSchema.catch({})
  })
  .transform((stored): TranscriptionTranscript => ({
    ...stored,
    segments: normalizeSegments(stored.segments),
    subtitleSource: null,
    model: null,
    provider: null,
    fileSize: null,
    summaryTemplateId: null,
    revision: 1,
    expiresAt: null
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
 * The records after a successful server list: its entries replace the ones from the server, the
 * records only this browser has stay.
 */
export function syncLocalHistory(
  records: readonly LocalHistoryRecord[],
  server: readonly TranscriptionTranscriptSummary[]
): LocalHistoryRecord[] {
  return [
    ...server.map((summary) => ({
      id: summary.id,
      title: summary.title,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      local: false,
      transcript: null
    })),
    ...records.filter((record) => record.local)
  ]
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

/** Stores the records (none removes the key) and tells every reader. Full storage is ignored. */
export function writeLocalHistory(key: string, records: readonly LocalHistoryRecord[]): void {
  try {
    if (records.length === 0) storage()?.removeItem(key)
    else storage()?.setItem(key, JSON.stringify(records))
  } catch {
    // Quota or privacy mode: the server's list stays authoritative.
  }
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
    if (event.key === null || event.key.startsWith('transcriptionHistory:')) listener()
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
