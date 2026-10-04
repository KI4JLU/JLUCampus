import { describe, expect, it } from 'vitest'
import type { TranscriptionTranscriptSummary } from '@justcampus/shared'
import {
  isLocalTranscriptId,
  normalizeSegments,
  parseLocalHistory,
  syncLocalHistory,
  updateRecord,
  withoutRecord,
  type LocalHistoryRecord
} from './local-store'
import {
  entryDate,
  groupHistory,
  historyGroup,
  matchesSearch,
  mergeHistory,
  sortHistory,
  type HistoryEntry
} from './model'

const NOW = new Date(2026, 9, 4, 15, 30)

function entry(id: string, title: string, updatedAt: string | null, local = false): HistoryEntry {
  return { id, title, createdAt: null, updatedAt, local }
}

function summary(id: string, title: string, updatedAt: string): TranscriptionTranscriptSummary {
  return {
    id,
    title,
    subtitle: null,
    language: 'de',
    duration: 11,
    originalFilename: null,
    createdAt: updatedAt,
    updatedAt,
    expiresAt: null
  }
}

describe('history groups', () => {
  it('groups by local calendar day', () => {
    expect(historyGroup(new Date(2026, 9, 4, 0, 0), NOW)).toBe('today')
    expect(historyGroup(new Date(2026, 9, 3, 23, 59), NOW)).toBe('yesterday')
    expect(historyGroup(new Date(2026, 9, 3, 0, 0), NOW)).toBe('yesterday')
    expect(historyGroup(new Date(2026, 8, 27, 0, 0), NOW)).toBe('last7')
    expect(historyGroup(new Date(2026, 8, 26, 23, 59), NOW)).toBe('older')
    expect(historyGroup(null, NOW)).toBe('older')
  })

  it('dates entries by their change, else their creation', () => {
    expect(entryDate({ createdAt: '2026-01-01T00:00:00Z', updatedAt: null })?.toISOString()).toBe(
      '2026-01-01T00:00:00.000Z'
    )
    expect(entryDate({ createdAt: 'nonsense', updatedAt: null })).toBeNull()
  })

  it('sorts newest first and groups, leaving out empty groups', () => {
    const entries = [
      entry('a', 'Alt', new Date(2026, 0, 1).toISOString()),
      entry('b', 'Heute früh', new Date(2026, 9, 4, 8).toISOString()),
      entry('c', 'Heute spät', new Date(2026, 9, 4, 14).toISOString()),
      entry('d', 'Ohne Datum', null)
    ]
    expect(sortHistory(entries).map((item) => item.id)).toEqual(['c', 'b', 'a', 'd'])
    const groups = groupHistory(entries, '', NOW)
    expect(groups.map((group) => [group.key, group.entries.map((item) => item.id)])).toEqual([
      ['today', ['c', 'b']],
      ['older', ['a', 'd']]
    ])
  })

  it('searches titles case-insensitively and trimmed', () => {
    const entries = [
      entry('a', 'Interview Müller', new Date(2026, 9, 4).toISOString()),
      entry('b', 'Teamsitzung', new Date(2026, 0, 1).toISOString())
    ]
    expect(matchesSearch(entries[0]!, '  müll ')).toBe(true)
    expect(groupHistory(entries, 'MÜLLER', NOW).map((group) => group.key)).toEqual(['today'])
    expect(groupHistory(entries, 'xyz', NOW)).toEqual([])
    expect(groupHistory(entries, '  ', NOW)).toHaveLength(2)
  })
})

describe('mergeHistory', () => {
  const local = [entry('local-1', 'Nur hier', null, true), entry('s-old', 'Gelöscht', null)]

  it('takes the server list plus records only this browser has', () => {
    const merged = mergeHistory([summary('s-1', 'Server', '2026-10-04T10:00:00Z')], local)
    expect(merged.map((item) => item.id)).toEqual(['s-1', 'local-1'])
  })

  it('falls back to every local record while the server list is missing', () => {
    expect(mergeHistory(undefined, local).map((item) => item.id)).toEqual(['local-1', 's-old'])
  })
})

describe('local history records', () => {
  const stored: LocalHistoryRecord[] = [
    {
      id: 's-1',
      title: 'Server',
      createdAt: null,
      updatedAt: '2026-10-04T10:00:00Z',
      local: false,
      transcript: null
    },
    {
      id: 'local-1',
      title: 'Lokal',
      createdAt: '2026-10-04T09:00:00Z',
      updatedAt: '2026-10-04T09:00:00Z',
      local: true,
      transcript: null
    }
  ]

  it('parses stored records and drops broken ones', () => {
    const raw = JSON.stringify([
      stored[0],
      { id: 'local-2', title: 'Kaputt', local: true },
      42,
      {
        id: 'local-3',
        title: 'Alt',
        createdAt: null,
        updatedAt: null,
        local: true,
        transcript: {
          id: 'local-3',
          title: 'Alt',
          createdAt: '2026-10-04T09:00:00Z',
          updatedAt: '2026-10-04T09:00:00Z',
          segments: JSON.stringify([{ id: 0, start: 0, end: 1, text: 'Hallo', speaker: null }])
        }
      }
    ])
    const records = parseLocalHistory(raw)
    expect(records.map((record) => record.id)).toEqual(['s-1', 'local-3'])
    expect(records[1]!.transcript?.segments).toEqual([
      { id: 0, start: 0, end: 1, text: 'Hallo', speaker: null, redactions: [] }
    ])
    expect(parseLocalHistory('not json')).toEqual([])
    expect(parseLocalHistory(null)).toEqual([])
  })

  it('accepts segments as an array or a JSON string', () => {
    const segment = { id: 1, start: 0, end: 2, text: 'x', speaker: 'A', redactions: [] }
    expect(normalizeSegments([segment])).toEqual([segment])
    expect(normalizeSegments(JSON.stringify([segment]))).toEqual([segment])
    expect(normalizeSegments('{')).toEqual([])
    expect(normalizeSegments({})).toEqual([])
  })

  it('replaces server records by the fresh list and keeps local ones', () => {
    const synced = syncLocalHistory(stored, [summary('s-2', 'Neu', '2026-10-04T11:00:00Z')])
    expect(synced.map((record) => record.id)).toEqual(['s-2', 'local-1'])
  })

  it('removes and changes records', () => {
    expect(withoutRecord(stored, 's-1').map((record) => record.id)).toEqual(['local-1'])
    expect(
      updateRecord(stored, 'local-1', (record) => ({ ...record, title: 'Neu' }))[1]!.title
    ).toBe('Neu')
    expect(isLocalTranscriptId('local-1')).toBe(true)
    expect(isLocalTranscriptId('0b7c')).toBe(false)
  })
})
