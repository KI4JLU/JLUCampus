import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  TranscriptionTranscript,
  TranscriptionTranscriptCreate,
  TranscriptionTranscriptSummary
} from '@justcampus/shared'
import {
  clearLocalHistories,
  isLocalTranscriptId,
  keepServerCopy,
  KEPT_SERVER_COPIES,
  localHistoryKey,
  localIdFor,
  normalizeSegments,
  parseLocalHistory,
  readLocalHistory,
  recordSaveOutcome,
  serverCopy,
  syncLocalHistory,
  updateRecord,
  withoutRecord,
  writeLocalHistory,
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

describe('clearLocalHistories', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("removes every user's history on sign-out and leaves other keys", () => {
    const map = new Map<string, string>()
    const localStorage = {
      get length() {
        return map.size
      },
      key: (index: number) => [...map.keys()][index] ?? null,
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key)
    }
    vi.stubGlobal('window', { localStorage })
    const record: LocalHistoryRecord = {
      id: 's-1',
      title: 'Server',
      createdAt: null,
      updatedAt: null,
      local: false,
      transcript: null
    }
    writeLocalHistory(localHistoryKey('module', 'alice'), [record])
    writeLocalHistory(localHistoryKey('module', 'bob'), [record])
    map.set('theme', 'dark')
    expect(readLocalHistory(localHistoryKey('module', 'alice'))).toHaveLength(1)

    clearLocalHistories()

    expect([...map.keys()]).toEqual(['theme'])
    expect(readLocalHistory(localHistoryKey('module', 'alice'))).toEqual([])
  })
})

function detail(id: string, revision = 3): TranscriptionTranscript {
  return {
    ...summary(id, `T ${id}`, '2026-10-04T10:00:00.000Z'),
    subtitleSource: 'ai',
    model: 'whisper',
    provider: 'speaches',
    fileSize: 12,
    text: 'Anna: Hallo',
    segments: [{ id: 0, start: 0, end: 1, text: 'Hallo', speaker: 'Anna', redactions: [] }],
    words: [],
    sourceFiles: [],
    speakerColors: {},
    summaryTemplateId: null,
    revision
  }
}

describe('kept copies of server transcripts', () => {
  it('keeps the newest copies, survives a fresh list and reads back with its revision', () => {
    let records: LocalHistoryRecord[] = []
    for (let index = 0; index <= KEPT_SERVER_COPIES; index++) {
      records = keepServerCopy(records, detail(`s-${index}`))
    }
    const kept = records.filter((record) => record.transcript).map((record) => record.id)
    expect(kept).toHaveLength(KEPT_SERVER_COPIES)
    expect(kept).not.toContain('s-0')
    const synced = syncLocalHistory(records, [summary('s-5', 'T s-5', '2026-10-04T10:00:00Z')])
    expect(synced.map((record) => record.id)).toEqual(['s-5'])
    const parsed = parseLocalHistory(JSON.stringify(synced))
    expect(serverCopy(parsed, 's-5')).toEqual(detail('s-5'))
    expect(serverCopy(parsed, 's-4')).toBeNull()
  })
})

describe('saves that did not reach the server', () => {
  const input: TranscriptionTranscriptCreate = {
    idempotencyKey: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    title: 'Gruppe 1',
    jobIds: ['0b7c2a4e-6f4d-4b8e-9a51-1d1f1c3e5a77'],
    language: 'de',
    duration: 10,
    segments: [{ id: 0, start: 0, end: 10, text: 'Hallo zusammen', speaker: 'Anna' }],
    sourceFiles: [
      {
        name: 'a.wav',
        size: 12,
        duration: 10,
        startTime: 0,
        endTime: 10,
        jobId: '0b7c2a4e-6f4d-4b8e-9a51-1d1f1c3e5a77'
      }
    ]
  }
  const now = new Date('2026-10-04T12:00:00.000Z')

  it('keeps a failed save once as a transcript of this browser that opens after a reload', () => {
    const records = recordSaveOutcome([], { input, error: new Error('offline') }, now)
    expect(records).toHaveLength(1)
    const record = records[0]!
    expect(record).toMatchObject({ id: localIdFor(input.idempotencyKey), local: true })
    expect(isLocalTranscriptId(record.id)).toBe(true)
    expect(record.transcript).toMatchObject({
      title: 'Gruppe 1',
      originalFilename: 'a.wav',
      createdAt: now.toISOString(),
      segments: [{ text: 'Hallo zusammen', speaker: 'Anna', redactions: [] }]
    })
    // A second failure of the same save adds nothing.
    expect(recordSaveOutcome(records, { input, error: new Error('again') }, now)).toEqual(records)
    // After a reload the record is read back with its whole transcript.
    expect(parseLocalHistory(JSON.stringify(records))).toEqual(records)
  })

  it('drops the copy once a retry reached the server, unless the user changed it', () => {
    const records = recordSaveOutcome([], { input, error: new Error('offline') }, now)
    const saved = { input, transcript: detail('0b7c2a4e-6f4d-4b8e-9a51-1d1f1c3e5a77') }
    expect(recordSaveOutcome(records, saved, now)).toEqual([])
    const edited = updateRecord(records, records[0]!.id, (record) => ({
      ...record,
      transcript: { ...record.transcript!, updatedAt: '2026-10-04T12:05:00.000Z' }
    }))
    expect(recordSaveOutcome(edited, saved, now)).toEqual(edited)
  })
})
