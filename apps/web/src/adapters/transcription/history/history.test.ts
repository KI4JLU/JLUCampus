import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  TranscriptionTranscript,
  TranscriptionTranscriptCreate,
  TranscriptionTranscriptSummary
} from '@justcampus/shared'
import { buildSpeakerBlocks } from '../segments/blocks'
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
  editStamp,
  isLocallyEdited,
  recordSaveOutcome,
  renameLocalRecord,
  serverCopy,
  settleTitleMerge,
  syncLocalHistory,
  updateRecord,
  withoutRecord,
  writeLocalHistory,
  type LocalHistoryRecord,
  type TitleMerge
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
import { carryLocalTitle } from './save-fallback'

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

  const failed = { input, error: new Error('offline') }
  /** The same group's save after a reload: the restored group has another idempotency key. */
  const afterReload: TranscriptionTranscriptCreate = {
    ...input,
    idempotencyKey: '3f2b1c8e-9d4a-4e6f-8b7c-5a1d2e3f4a5b',
    title: 'a.wav'
  }
  const server = (title = 'Gruppe 1'): TranscriptionTranscript => ({
    ...detail('5d1e3c9a-2b4f-4a6e-8c7d-9e0f1a2b3c4d', 1),
    title,
    subtitle: null
  })
  const reload = (records: LocalHistoryRecord[]): LocalHistoryRecord[] =>
    parseLocalHistory(JSON.stringify(records))

  it('keeps a failed save once as a transcript of this browser that opens after a reload', () => {
    const { records } = recordSaveOutcome([], failed, now)
    expect(records).toHaveLength(1)
    const record = records[0]!
    expect(record).toMatchObject({
      id: localIdFor(input.idempotencyKey),
      local: true,
      pendingJobIds: input.jobIds
    })
    expect(isLocalTranscriptId(record.id)).toBe(true)
    expect(record.transcript).toMatchObject({
      title: 'Gruppe 1',
      originalFilename: 'a.wav',
      createdAt: now.toISOString(),
      segments: [{ text: 'Hallo zusammen', speaker: 'Anna', redactions: [] }]
    })
    // A second failure of the same save adds nothing, nor does one after a reload (another key).
    expect(recordSaveOutcome(records, { input, error: new Error('again') }, now).records).toEqual(
      records
    )
    const again = { input: afterReload, error: new Error('again') }
    expect(recordSaveOutcome(reload(records), again, now).records).toEqual(records)
    // After a reload the record is read back with its whole transcript.
    expect(reload(records)).toEqual(records)
  })

  it('drops an unchanged copy once a retry with the same key reached the server', () => {
    const { records } = recordSaveOutcome([], failed, now)
    const outcome = recordSaveOutcome(records, { input, transcript: server() }, now)
    expect(outcome.records).toEqual([])
    expect(outcome.replaced).toEqual([{ localId: records[0]!.id, transcriptId: server().id }])
    expect(outcome.merges).toEqual([])
    expect(outcome.kept).toEqual([])
  })

  it('drops an unchanged copy once the same jobs were saved after a reload, under another key', () => {
    const { records } = recordSaveOutcome([], failed, now)
    const saved = { input: afterReload, transcript: server('a.wav') }
    const outcome = recordSaveOutcome(reload(records), saved, now)
    expect(outcome.records).toEqual([])
    expect(outcome.replaced).toEqual([{ localId: records[0]!.id, transcriptId: server().id }])
    // The merged history lists the transcript once, from the server.
    const merged = mergeHistory([summary(server().id, 'a.wav', now.toISOString())], outcome.records)
    expect(merged.map((item) => item.id)).toEqual([server().id])
  })

  it('reads copies stored before by the jobs of their source files', () => {
    const { records } = recordSaveOutcome([], failed, now)
    // Undefined fields are not stored.
    const legacy = records.map((record) => ({ ...record, pendingJobIds: undefined }))
    expect(reload(legacy)[0]!.pendingJobIds).toBeUndefined()
    const saved = { input: afterReload, transcript: server('a.wav') }
    expect(recordSaveOutcome(reload(legacy), saved, now).records).toEqual([])
  })

  it('drops a copy of several files only once every one of its jobs reached the server', () => {
    const second = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
    const group: TranscriptionTranscriptCreate = {
      ...input,
      jobIds: [...input.jobIds, second],
      sourceFiles: [
        ...input.sourceFiles,
        { ...input.sourceFiles[0]!, name: 'b.wav', jobId: second }
      ]
    }
    const { records } = recordSaveOutcome([], { input: group, error: new Error('offline') }, now)
    const first = recordSaveOutcome(records, { input: afterReload, transcript: server() }, now)
    expect(first.replaced).toEqual([])
    expect(first.records[0]).toMatchObject({ id: records[0]!.id, pendingJobIds: [second] })
    const other = { ...afterReload, idempotencyKey: '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e' }
    const saved = { input: { ...other, jobIds: [second] }, transcript: server() }
    const last = recordSaveOutcome(first.records, saved, now)
    expect(last.records).toEqual([])
    expect(last.replaced).toEqual([{ localId: records[0]!.id, transcriptId: server().id }])
  })

  describe('failed saves of restored groups', () => {
    const second = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
    const both: TranscriptionTranscriptCreate = {
      ...input,
      jobIds: [...input.jobIds, second],
      sourceFiles: [
        ...input.sourceFiles,
        { ...input.sourceFiles[0]!, name: 'b.wav', jobId: second }
      ]
    }
    /** Group B after a reload: one restored file, another key. */
    const onlySecond: TranscriptionTranscriptCreate = {
      ...afterReload,
      idempotencyKey: '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e',
      title: 'b.wav',
      jobIds: [second],
      sourceFiles: [{ ...input.sourceFiles[0]!, name: 'b.wav', jobId: second }]
    }
    const fail = (
      save: TranscriptionTranscriptCreate
    ): { input: TranscriptionTranscriptCreate; error: Error } => ({
      input: save,
      error: new Error('x')
    })

    it('adds no copy when each restored file fails again, and drops it once both are saved', () => {
      const { records } = recordSaveOutcome([], fail(both), now)
      const first = recordSaveOutcome(reload(records), fail(afterReload), now)
      expect(first.records).toEqual(records)
      expect(first.replaced).toEqual([])
      const second_ = recordSaveOutcome(first.records, fail(onlySecond), now)
      expect(second_.records).toEqual(records)
      // Saved one by one, the copy waits for the other file, then goes.
      const savedA = recordSaveOutcome(
        second_.records,
        { input: afterReload, transcript: server('a.wav') },
        now
      )
      expect(savedA.records[0]).toMatchObject({ id: records[0]!.id, pendingJobIds: [second] })
      // The other file failing once more still adds nothing.
      expect(recordSaveOutcome(savedA.records, fail(onlySecond), now).records).toEqual(
        savedA.records
      )
      const savedB = recordSaveOutcome(
        savedA.records,
        { input: onlySecond, transcript: server('b.wav') },
        now
      )
      expect(savedB.records).toEqual([])
      expect(savedB.replaced).toEqual([{ localId: records[0]!.id, transcriptId: server().id }])
    })

    it('keeps an edited copy as the one holding its jobs', () => {
      const { records } = recordSaveOutcome([], fail(both), now)
      const renamed = renameLocalRecord(records, records[0]!.id, 'Interview', new Date(1))
      expect(recordSaveOutcome(renamed, fail(afterReload), now).records).toEqual(renamed)
    })

    it('replaces unedited copies of fewer files by the copy of a larger group', () => {
      const a = recordSaveOutcome([], fail(afterReload), now).records
      const ab = recordSaveOutcome(a, fail(both), now)
      expect(ab.records.map((record) => record.id)).toEqual([localIdFor(both.idempotencyKey)])
      expect(ab.records[0]!.pendingJobIds).toEqual(both.jobIds)
      expect(ab.replaced).toEqual([
        { localId: a[0]!.id, transcriptId: localIdFor(both.idempotencyKey) }
      ])
      // An edited copy stays next to it.
      const edited = renameLocalRecord(a, a[0]!.id, 'Meine Fassung', new Date(1))
      const kept = recordSaveOutcome(edited, fail(both), now)
      expect(kept.records.map((record) => record.id)).toEqual([
        localIdFor(both.idempotencyKey),
        a[0]!.id
      ])
      expect(kept.replaced).toEqual([])
    })

    it('adds a copy for files of separate failed groups saved together', () => {
      const a = recordSaveOutcome([], fail(afterReload), now).records
      const b = recordSaveOutcome(a, fail(onlySecond), now).records
      expect(b).toHaveLength(2)
      // Both files are already held: their combined save adds nothing.
      expect(recordSaveOutcome(b, fail(both), now).records).toEqual(b)
    })
  })

  it('counts a rename from the history as a change and moves the copy up', () => {
    const { records } = recordSaveOutcome([], failed, now)
    const later = new Date('2026-10-04T12:05:00.000Z')
    const renamed = renameLocalRecord(records, records[0]!.id, 'Interview Meier', later)
    expect(renamed[0]).toMatchObject({ title: 'Interview Meier', updatedAt: later.toISOString() })
    expect(renamed[0]!.transcript).toMatchObject({
      title: 'Interview Meier',
      updatedAt: later.toISOString()
    })
    expect(isLocallyEdited(records[0]!)).toBe(false)
    expect(isLocallyEdited(renamed[0]!)).toBe(true)
  })

  it('keeps a renamed copy until its title reached the server, after a retry with either key', () => {
    const { records } = recordSaveOutcome([], failed, now)
    const later = new Date('2026-10-04T12:05:00.000Z')
    const renamed = renameLocalRecord(records, records[0]!.id, 'Interview Meier', later)
    for (const retry of [input, afterReload]) {
      const outcome = recordSaveOutcome(
        reload(renamed),
        { input: retry, transcript: server(retry.title) },
        now
      )
      expect(outcome.records).toEqual(renamed)
      expect(outcome.replaced).toEqual([])
      expect(outcome.merges).toEqual([
        {
          localId: renamed[0]!.id,
          transcriptId: server().id,
          title: 'Interview Meier',
          subtitle: null,
          stamp: editStamp(renamed[0]!)
        }
      ])
      const merge = outcome.merges[0]!
      // Carried: one entry, the server's. Refused: the copy stays on its own.
      expect(settleTitleMerge(outcome.records, merge, true)).toEqual({
        records: [],
        outcome: 'merged'
      })
      const refused = settleTitleMerge(outcome.records, merge, false)
      expect(refused.outcome).toBe('kept')
      expect(refused.records[0]).toMatchObject({ title: 'Interview Meier', pendingJobIds: [] })
      // A later save of the same jobs leaves a copy of its own alone.
      const next = recordSaveOutcome(refused.records, { input: retry, transcript: server() }, now)
      expect(next.records).toEqual(refused.records)
      expect(next.merges).toEqual([])
    }
  })

  it('carries a title set in the open copy, whose colours the session filled in', () => {
    const { records } = recordSaveOutcome([], failed, now)
    const at = '2026-10-04T12:05:00.000Z'
    const opened = updateRecord(records, records[0]!.id, (record) => ({
      ...record,
      title: 'Interview Meier',
      updatedAt: at,
      transcript: {
        ...record.transcript!,
        title: 'Interview Meier',
        // What the session's `saveLocally` stores: every speaker shown gets a colour.
        speakerColors: buildSpeakerBlocks(record.transcript!.segments, {}).speakerColors,
        updatedAt: at
      }
    }))
    expect(opened[0]!.transcript!.speakerColors).not.toEqual({})
    const outcome = recordSaveOutcome(opened, { input, transcript: server() }, now)
    expect(outcome.merges).toHaveLength(1)
    expect(outcome.kept).toEqual([])
  })

  it('keeps a copy edited after the merge was planned', () => {
    const { records } = recordSaveOutcome([], failed, now)
    const renamed = renameLocalRecord(records, records[0]!.id, 'Interview Meier', new Date(1))
    const { merges } = recordSaveOutcome(renamed, { input, transcript: server() }, now)
    const edited = renameLocalRecord(renamed, records[0]!.id, 'Interview Schulz', new Date(2))
    const settled = settleTitleMerge(edited, merges[0]!, true)
    expect(settled.outcome).toBe('kept')
    expect(settled.records[0]).toMatchObject({ title: 'Interview Schulz', pendingJobIds: [] })
    expect(settleTitleMerge([], merges[0]!, true)).toEqual({ records: [], outcome: 'gone' })
  })

  it('keeps a copy whose text the user changed next to the server transcript', () => {
    const { records } = recordSaveOutcome([], failed, now)
    const at = '2026-10-04T12:05:00.000Z'
    const edited = updateRecord(records, records[0]!.id, (record) => ({
      ...record,
      updatedAt: at,
      transcript: {
        ...record.transcript!,
        segments: [{ ...record.transcript!.segments[0]!, text: 'Hallo alle zusammen' }],
        updatedAt: at
      }
    }))
    const outcome = recordSaveOutcome(
      reload(edited),
      { input: afterReload, transcript: server() },
      now
    )
    expect(outcome.kept).toEqual([records[0]!.id])
    expect(outcome.replaced).toEqual([])
    expect(outcome.merges).toEqual([])
    expect(outcome.records).toEqual([{ ...edited[0]!, pendingJobIds: [] }])
  })
})

describe('carryLocalTitle', () => {
  const map = new Map<string, string>()
  const key = localHistoryKey('module', 'alice')
  const merge: TitleMerge = {
    localId: 'local-1',
    transcriptId: 's-1',
    title: 'Interview Meier',
    subtitle: 'Meine Notiz',
    stamp: '2026-10-04T12:05:00.000Z|2026-10-04T12:05:00.000Z'
  }
  const copy: LocalHistoryRecord = {
    id: 'local-1',
    title: 'Interview Meier',
    createdAt: '2026-10-04T12:00:00.000Z',
    updatedAt: '2026-10-04T12:05:00.000Z',
    local: true,
    transcript: {
      ...detail('local-1'),
      title: 'Interview Meier',
      createdAt: '2026-10-04T12:00:00.000Z',
      updatedAt: '2026-10-04T12:05:00.000Z'
    },
    pendingJobIds: ['0b7c2a4e-6f4d-4b8e-9a51-1d1f1c3e5a77']
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    map.clear()
  })

  function stubStorage(): void {
    vi.stubGlobal('window', {
      localStorage: {
        get length() {
          return map.size
        },
        key: (index: number) => [...map.keys()][index] ?? null,
        getItem: (name: string) => map.get(name) ?? null,
        setItem: (name: string, value: string) => void map.set(name, value),
        removeItem: (name: string) => void map.delete(name)
      }
    })
  }

  it('sends the title on the latest revision and then drops the copy', async () => {
    stubStorage()
    writeLocalHistory(key, [copy])
    const get = vi.fn(async () => detail('s-1', 4))
    const patch = vi.fn(async () => ({ ...detail('s-1', 5), title: 'Interview Meier' }))
    const result = await carryLocalTitle(key, merge, { get, patch })
    expect(patch).toHaveBeenCalledWith('s-1', {
      baseRevision: 4,
      title: 'Interview Meier',
      subtitle: 'Meine Notiz'
    })
    expect(result.outcome).toBe('merged')
    expect(result.saved?.revision).toBe(5)
    expect(readLocalHistory(key)).toEqual([])
  })

  it('reports a write the storage refused and keeps the stored records', () => {
    stubStorage()
    writeLocalHistory(key, [copy])
    const quota = (): never => {
      throw new DOMException('full', 'QuotaExceededError')
    }
    const server: LocalHistoryRecord = {
      id: 's-2',
      title: 'Server',
      createdAt: null,
      updatedAt: null,
      local: false,
      transcript: detail('s-2')
    }
    const renamed = renameLocalRecord([copy], copy.id, 'Neu', new Date(1))
    // Without room even after dropping the server copies, nothing is reported as stored.
    vi.stubGlobal('window', {
      localStorage: { getItem: (name: string) => map.get(name) ?? null, setItem: quota }
    })
    expect(writeLocalHistory(key, [server, ...renamed])).toBe(false)
    expect(readLocalHistory(key)).toEqual([copy])
    // Room for the local copy once the server copy goes: stored.
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (name: string) => map.get(name) ?? null,
        setItem: (name: string, value: string) => {
          if (value.includes('"transcript":{"id":"s-2"')) quota()
          map.set(name, value)
        }
      }
    })
    expect(writeLocalHistory(key, [server, ...renamed])).toBe(true)
    expect(readLocalHistory(key).map((record) => record.title)).toEqual(['Server', 'Neu'])
    expect(serverCopy(readLocalHistory(key), 's-2')).toBeNull()
  })

  it('keeps the copy when the storage refuses to drop it after the title arrived', async () => {
    stubStorage()
    writeLocalHistory(key, [copy])
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (name: string) => map.get(name) ?? null,
        setItem: () => {
          throw new DOMException('full', 'QuotaExceededError')
        },
        removeItem: () => {
          throw new DOMException('blocked', 'SecurityError')
        }
      }
    })
    const get = vi.fn(async () => detail('s-1', 4))
    const patch = vi.fn(async () => ({ ...detail('s-1', 5), title: 'Interview Meier' }))
    const result = await carryLocalTitle(key, merge, { get, patch })
    expect(result.outcome).toBe('kept')
    expect(readLocalHistory(key)).toEqual([copy])
  })

  it('keeps the copy on its own when the server refuses', async () => {
    stubStorage()
    writeLocalHistory(key, [copy])
    const get = vi.fn(async () => detail('s-1', 4))
    const patch = vi.fn(async () => Promise.reject(new Error('offline')))
    const result = await carryLocalTitle(key, merge, { get, patch })
    expect(result).toEqual({ outcome: 'kept', saved: null })
    expect(readLocalHistory(key)).toEqual([{ ...copy, pendingJobIds: [] }])
  })
})
