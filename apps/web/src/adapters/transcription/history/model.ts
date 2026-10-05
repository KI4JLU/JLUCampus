import type { TranscriptionTranscriptSummary } from '@justcampus/shared'

/**
 * The history list after kiChat's `HistoryManager` and `Utils` (T-37, T-38): newest change first,
 * grouped into today, yesterday, the last seven days and older, filtered by title.
 */

export interface HistoryEntry {
  id: string
  title: string
  createdAt: string | null
  updatedAt: string | null
  /** Only in this browser: saving it on the server failed (T-39). */
  local: boolean
}

export const HISTORY_GROUPS = ['today', 'yesterday', 'last7', 'older'] as const
export type HistoryGroupKey = (typeof HISTORY_GROUPS)[number]

/** The date an entry sorts and groups by: its last change, else its creation. */
export function entryDate(entry: Pick<HistoryEntry, 'createdAt' | 'updatedAt'>): Date | null {
  const raw = entry.updatedAt || entry.createdAt
  if (!raw) return null
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? null : date
}

/** The group of a date, by the local calendar day; without a date `older`. */
export function historyGroup(date: Date | null, now: Date): HistoryGroupKey {
  if (!date) return 'older'
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  const weekAgo = new Date(today)
  weekAgo.setDate(today.getDate() - 7)
  if (date >= today) return 'today'
  if (date >= yesterday) return 'yesterday'
  if (date >= weekAgo) return 'last7'
  return 'older'
}

/** Newest first; entries without a date last. */
export function sortHistory(entries: readonly HistoryEntry[]): HistoryEntry[] {
  return [...entries].sort(
    (a, b) => (entryDate(b)?.getTime() ?? 0) - (entryDate(a)?.getTime() ?? 0)
  )
}

/** Whether an entry matches a search: its title contains the trimmed query, ignoring case. */
export function matchesSearch(entry: HistoryEntry, query: string): boolean {
  const needle = query.trim().toLowerCase()
  return needle === '' || entry.title.toLowerCase().includes(needle)
}

export interface HistoryGroup {
  key: HistoryGroupKey
  entries: HistoryEntry[]
}

/**
 * The sorted entries that match the search, in their date groups; groups without a match are
 * left out.
 */
export function groupHistory(
  entries: readonly HistoryEntry[],
  query: string,
  now: Date
): HistoryGroup[] {
  const groups: HistoryGroup[] = []
  for (const entry of sortHistory(entries)) {
    if (!matchesSearch(entry, query)) continue
    const key = historyGroup(entryDate(entry), now)
    const last = groups[groups.length - 1]
    if (last?.key === key) last.entries.push(entry)
    else groups.push({ key, entries: [entry] })
  }
  return groups
}

/** A server entry as a history entry. */
export function serverEntry(summary: TranscriptionTranscriptSummary): HistoryEntry {
  return {
    id: summary.id,
    title: summary.title,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    local: false
  }
}

/**
 * The list to show (T-39): the server's, which is authoritative, plus the records only this
 * browser has; while the server's is unavailable, every record this browser keeps.
 */
export function mergeHistory(
  server: readonly TranscriptionTranscriptSummary[] | undefined,
  local: readonly HistoryEntry[]
): HistoryEntry[] {
  if (!server) return [...local]
  const entries = server.map(serverEntry)
  const ids = new Set(entries.map((entry) => entry.id))
  for (const entry of local) if (entry.local && !ids.has(entry.id)) entries.push(entry)
  return entries
}
