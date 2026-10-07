import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TRANSCRIPTION_EMPTY_SPEAKER_TEXT,
  type TranscriptionTranscript,
  type TranscriptionTranscriptCreate,
  type TranscriptionTranscriptPatch
} from '@justcampus/shared'
import { ApiRequestError } from '@/lib/api'
import { reassignBlock, updateSegmentText } from '../segments'
import { seg } from '../segments/test-fixtures'
import {
  changeLocalHistory,
  localHistoryKey,
  localIdFor,
  localRecord,
  readLocalHistory,
  recordSaveOutcome,
  registerOpenLocalCopy,
  saveLocalCopy,
  settleTitleMerge,
  withoutRecord,
  writeLocalHistory,
  type LocalHistoryRecord,
  type SaveReconciliation
} from '../history/local-store'
import { fakeEvents, type FakeEvents } from '../fake-events'
import { stableStringify } from './compare'
import { ResultSession, type SessionDeps } from './session'

function transcript(change: Partial<TranscriptionTranscript> = {}): TranscriptionTranscript {
  return {
    id: '0b7c2a4e-6f4d-4b8e-9a51-1d1f1c3e5a77',
    title: 'Interview',
    subtitle: null,
    subtitleSource: null,
    language: 'de',
    duration: 20,
    originalFilename: 'a.wav',
    createdAt: '2026-10-04T10:00:00.000Z',
    updatedAt: '2026-10-04T10:00:00.000Z',
    expiresAt: null,
    model: null,
    provider: null,
    fileSize: null,
    text: '',
    segments: [seg(0, 0, 5, 'Hallo.', 'Anna'), seg(1, 5, 10, 'Tag.', 'Ben')],
    words: [],
    sourceFiles: [],
    speakerColors: {},
    summaryTemplateId: null,
    revision: 1,
    ...change
  }
}

interface FakeServer {
  deps: SessionDeps
  patches: TranscriptionTranscriptPatch[]
  stored: TranscriptionTranscript
  failWith: (error: ApiRequestError | Error | null) => void
}

/** A fake server holding one transcript, answering like the module's routes. */
function fakeServer(initial: TranscriptionTranscript): FakeServer {
  let stored = initial
  const patches: TranscriptionTranscriptPatch[] = []
  let fail: ApiRequestError | Error | null = null
  const deps: SessionDeps = {
    patch: vi.fn(async (_id: string, patch: TranscriptionTranscriptPatch) => {
      patches.push(patch)
      await Promise.resolve()
      if (fail) throw fail
      if (patch.baseRevision !== stored.revision) throw new ApiRequestError(409, null)
      stored = {
        ...stored,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.subtitle !== undefined
          ? { subtitle: patch.subtitle || null, subtitleSource: patch.subtitle ? 'manual' : null }
          : {}),
        ...(patch.segments
          ? { segments: patch.segments as TranscriptionTranscript['segments'] }
          : {}),
        ...(patch.speakerColors ? { speakerColors: patch.speakerColors } : {}),
        revision: stored.revision + 1
      } as TranscriptionTranscript
      return stored
    }),
    get: vi.fn(async () => stored),
    generateSubtitle: vi.fn(async () => {
      stored = { ...stored, subtitle: 'KI', subtitleSource: 'ai', revision: stored.revision + 1 }
      return stored
    }),
    optimize: vi.fn(async () => ({
      segments: stored.segments.map((segment) => ({ ...segment, speaker: 'Anna' }))
    }))
  }
  return {
    deps,
    patches,
    get stored() {
      return stored
    },
    set stored(value: TranscriptionTranscript) {
      stored = value
    },
    failWith(error: ApiRequestError | Error | null) {
      fail = error
    }
  }
}

const rename = (session: ResultSession, block: number, speaker: string): boolean =>
  session.edit(({ segments, blocks }) => {
    const changed = reassignBlock(segments, blocks[block]!, speaker)
    return changed ? { segments: changed } : null
  })

describe('ResultSession saving', () => {
  it('saves an edit with the base revision and the colours of every speaker', async () => {
    const server = fakeServer(transcript())
    const session = new ResultSession(server.stored, server.deps)
    expect(rename(session, 1, 'Cem')).toBe(true)
    expect(session.getState().saveStatus).toBe('pending')
    await session.flush()
    expect(server.patches).toHaveLength(1)
    expect(server.patches[0]!.baseRevision).toBe(1)
    expect(Object.keys(server.patches[0]!.speakerColors!)).toEqual(['Anna', 'Ben', 'Cem'])
    expect(session.getState()).toMatchObject({ saveStatus: 'saved', savedCount: 1 })
    expect(session.hasUnsavedChanges()).toBe(false)
  })

  it('sends edits made during a save together afterwards', async () => {
    const server = fakeServer(transcript())
    const session = new ResultSession(server.stored, server.deps)
    rename(session, 1, 'Cem')
    rename(session, 0, 'Dana')
    rename(session, 1, 'Emil')
    await session.flush()
    expect(server.patches).toHaveLength(1)
    expect(server.stored.segments.map((segment) => segment.speaker)).toEqual(['Dana', 'Emil'])
  })

  it('confirms the save button without anything to send, as kiChat saves on every click', async () => {
    const server = fakeServer(transcript())
    const session = new ResultSession(server.stored, server.deps)
    await session.save()
    expect(server.patches).toHaveLength(0)
    expect(session.getState()).toMatchObject({ saveStatus: 'saved', savedCount: 1 })
    await session.save()
    expect(session.getState().savedCount).toBe(2)
  })

  it('counts a save the button waited for once', async () => {
    const server = fakeServer(transcript())
    const session = new ResultSession(server.stored, server.deps)
    rename(session, 1, 'Cem')
    await session.save()
    expect(server.patches).toHaveLength(1)
    expect(session.getState().savedCount).toBe(1)
  })

  it('does not confirm the save button while a save failed', async () => {
    const server = fakeServer(transcript())
    const session = new ResultSession(server.stored, server.deps)
    server.failWith(new TypeError('Failed to fetch'))
    rename(session, 1, 'Cem')
    await session.save()
    expect(session.getState()).toMatchObject({ saveStatus: 'failed', savedCount: 0 })
  })

  it('reports a failed save and retries it', async () => {
    const server = fakeServer(transcript())
    const session = new ResultSession(server.stored, server.deps)
    server.failWith(new TypeError('Failed to fetch'))
    rename(session, 1, 'Cem')
    await session.flush()
    expect(session.getState().saveStatus).toBe('failed')
    expect(session.hasUnsavedChanges()).toBe(true)
    server.failWith(null)
    session.retry()
    await session.flush()
    expect(session.getState().saveStatus).toBe('saved')
    expect(server.stored.segments[1]!.speaker).toBe('Cem')
  })

  it('takes a newer revision that only changed the subtitle', async () => {
    const server = fakeServer(transcript())
    const session = new ResultSession(server.stored, server.deps)
    server.stored = { ...server.stored, subtitle: 'Neu', subtitleSource: 'ai', revision: 2 }
    rename(session, 1, 'Cem')
    await session.flush()
    expect(session.getState().saveStatus).toBe('saved')
    expect(session.getState().transcript.subtitle).toBe('Neu')
    expect(server.stored.revision).toBe(3)
  })

  it('stops at a conflict with other segments until the user decides', async () => {
    const server = fakeServer(transcript())
    const session = new ResultSession(server.stored, server.deps)
    server.stored = {
      ...server.stored,
      segments: [seg(0, 0, 5, 'Anders.', 'Anna')],
      revision: 2
    }
    rename(session, 1, 'Cem')
    await session.flush()
    expect(session.getState().saveStatus).toBe('conflict')
    expect(await session.overwrite()).toBe(true)
    await session.flush()
    expect(session.getState().saveStatus).toBe('saved')
    expect(server.stored.segments.map((segment) => segment.text)).toEqual(['Hallo.', 'Tag.'])
  })

  it('reloads the server copy and forgets the edits', async () => {
    const server = fakeServer(transcript())
    const session = new ResultSession(server.stored, server.deps)
    server.stored = { ...server.stored, segments: [seg(0, 0, 5, 'Anders.', 'Anna')], revision: 2 }
    rename(session, 1, 'Cem')
    await session.flush()
    expect(await session.reload()).toBe(true)
    expect(session.getState()).toMatchObject({ saveStatus: 'saved', undo: [] })
    expect(session.getState().segments.map((segment) => segment.text)).toEqual(['Anders.'])
  })
})

describe('ResultSession title and subtitle', () => {
  it('saves the title on its own and keeps the edits', async () => {
    const server = fakeServer(transcript())
    const session = new ResultSession(server.stored, server.deps)
    expect(await session.setTitle('  Neuer Titel ')).toBe(true)
    expect(server.patches).toEqual([{ baseRevision: 1, title: 'Neuer Titel' }])
    expect(session.getState().transcript.title).toBe('Neuer Titel')
  })

  it('restores the title when the server refuses it', async () => {
    const server = fakeServer(transcript())
    const session = new ResultSession(server.stored, server.deps)
    server.failWith(new ApiRequestError(400, null))
    expect(await session.setTitle('Neu')).toBe(false)
    expect(session.getState().transcript.title).toBe('Interview')
  })

  it('ignores an empty or unchanged title', async () => {
    const server = fakeServer(transcript())
    const session = new ResultSession(server.stored, server.deps)
    expect(await session.setTitle('   ')).toBe(true)
    expect(await session.setTitle('Interview')).toBe(true)
    expect(server.patches).toEqual([])
  })

  it('saves and removes a subtitle', async () => {
    const server = fakeServer(transcript())
    const session = new ResultSession(server.stored, server.deps)
    await session.setSubtitle('Kurz')
    expect(session.getState().transcript).toMatchObject({
      subtitle: 'Kurz',
      subtitleSource: 'manual'
    })
    await session.setSubtitle('')
    expect(server.patches[1]).toEqual({ baseRevision: 2, subtitle: '' })
    expect(session.getState().transcript.subtitle).toBeNull()
  })

  it('generates an AI subtitle', async () => {
    const server = fakeServer(transcript())
    const session = new ResultSession(server.stored, server.deps)
    expect(await session.generateSubtitle()).toBe(true)
    expect(session.getState().transcript).toMatchObject({ subtitle: 'KI', subtitleSource: 'ai' })
    rename(session, 1, 'Cem')
    await session.flush()
    expect(session.getState().saveStatus).toBe('saved')
  })
})

describe('ResultSession AI subtitle (T-23)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-04T10:01:00.000Z'))
  })
  afterEach(() => vi.useRealTimers())

  const ID = transcript().id
  const metadata = { type: 'transcriptMetadata', data: { id: ID } } as const

  /** A session of a fresh transcript listening to a stand-in stream. */
  function awaiting(
    open = true,
    change: Partial<TranscriptionTranscript> = {}
  ): {
    server: FakeServer
    events: FakeEvents
    session: ResultSession
  } {
    const server = fakeServer(transcript(change))
    const events = fakeEvents(open)
    const session = new ResultSession(server.stored, { ...server.deps, events })
    return { server, events, session }
  }

  it('fetches the detail once on connect and once the chat model is done', async () => {
    const { server, events, session } = awaiting()
    session.expectSubtitle()
    session.expectSubtitle()
    expect(session.getState().awaitingSubtitle).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    // In case the event came before the session listened.
    expect(server.deps.get).toHaveBeenCalledTimes(1)
    expect(events.subscribers).toBe(1)

    // The module writes it without a new revision.
    server.stored = { ...server.stored, subtitle: 'KI-Zeile', subtitleSource: 'ai' }
    events.emit({
      type: 'transcriptMetadata',
      data: { id: '1d1f1c3e-6f4d-4b8e-9a51-0b7c2a4e5a77' }
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(server.deps.get).toHaveBeenCalledTimes(1)
    events.emit(metadata)
    await vi.advanceTimersByTimeAsync(0)
    expect(server.deps.get).toHaveBeenCalledTimes(2)
    expect(session.getState().transcript.subtitle).toBe('KI-Zeile')
    expect(session.getState().awaitingSubtitle).toBe(false)
    expect(events.subscribers).toBe(0)
  })

  it('stops waiting once the chat model wrote nothing, or after a minute', async () => {
    const { server, events, session } = awaiting()
    session.expectSubtitle()
    events.emit(metadata)
    await vi.advanceTimersByTimeAsync(0)
    expect(session.getState()).toMatchObject({ awaitingSubtitle: false })
    expect(session.getState().transcript.subtitle).toBeNull()

    const quiet = awaiting(false)
    quiet.session.expectSubtitle()
    await vi.advanceTimersByTimeAsync(59_000)
    expect(quiet.session.getState().awaitingSubtitle).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(quiet.session.getState().awaitingSubtitle).toBe(false)
    expect(quiet.events.subscribers).toBe(0)
    expect(quiet.server.deps.get).not.toHaveBeenCalled()
    expect(server.deps.get).toHaveBeenCalledTimes(2)
  })

  it('catches up when the stream connects again', async () => {
    const { server, events, session } = awaiting(false)
    session.expectSubtitle()
    server.stored = { ...server.stored, subtitle: 'KI-Zeile', subtitleSource: 'ai' }
    events.setOpen(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(session.getState().transcript.subtitle).toBe('KI-Zeile')
    expect(session.getState().awaitingSubtitle).toBe(false)
  })

  it('does not wait for a subtitle of an older transcript', () => {
    vi.setSystemTime(new Date('2026-10-05T10:00:00.000Z'))
    const { events, session } = awaiting()
    session.expectSubtitle()
    expect(session.getState().awaitingSubtitle).toBe(false)
    expect(events.subscribers).toBe(0)
  })

  it('keeps what the user typed, and stops listening on close', async () => {
    const { server, events, session } = awaiting()
    session.expectSubtitle()
    session.setEditingSubtitle(true)
    server.stored = { ...server.stored, subtitle: 'KI-Zeile', subtitleSource: 'ai', revision: 2 }
    await vi.advanceTimersByTimeAsync(0)
    expect(session.getState().transcript.subtitle).toBeNull()
    expect(session.getState().awaitingSubtitle).toBe(true)
    session.close()
    expect(session.getState().awaitingSubtitle).toBe(false)
    expect(events.subscribers).toBe(0)

    const typed = awaiting()
    typed.session.expectSubtitle()
    await typed.session.setSubtitle('Meine Zeile')
    expect(typed.session.getState().awaitingSubtitle).toBe(false)
    // The AI title is still awaited, until the chat model is done.
    expect(typed.events.subscribers).toBe(1)
    typed.events.emit(metadata)
    await vi.advanceTimersByTimeAsync(0)
    expect(typed.events.subscribers).toBe(0)
    expect(typed.session.getState().transcript.subtitle).toBe('Meine Zeile')
  })

  it('waits for the AI title too, also when the subtitle is there already', async () => {
    const { server, events, session } = awaiting(true, {
      subtitle: 'Meine Zeile',
      subtitleSource: 'manual'
    })
    session.expectSubtitle()
    // Nothing to show as busy: the subtitle is there.
    expect(session.getState().awaitingSubtitle).toBe(false)
    await vi.advanceTimersByTimeAsync(0)
    // Fetched on connect with the title as saved: the wait goes on.
    expect(events.subscribers).toBe(1)
    server.stored = { ...server.stored, title: 'Gießener Interview' }
    events.emit(metadata)
    await vi.advanceTimersByTimeAsync(0)
    expect(session.getState().transcript.title).toBe('Gießener Interview')
    expect(events.subscribers).toBe(0)
    expect(server.deps.get).toHaveBeenCalledTimes(2)

    // The subtitle ends the busy state at once; the title is still awaited after it.
    const later = awaiting(false)
    later.session.expectSubtitle()
    later.server.stored = { ...later.server.stored, subtitle: 'KI-Zeile', subtitleSource: 'ai' }
    later.events.setOpen(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(later.session.getState().awaitingSubtitle).toBe(false)
    expect(later.events.subscribers).toBe(1)
    later.server.stored = { ...later.server.stored, title: 'KI-Titel' }
    // A reconnect fetches again, and the new title ends the wait.
    later.events.setOpen(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(later.session.getState().transcript).toMatchObject({
      title: 'KI-Titel',
      subtitle: 'KI-Zeile'
    })
    expect(later.events.subscribers).toBe(0)
    expect(later.server.deps.get).toHaveBeenCalledTimes(2)
  })

  it('stops waiting for the title once the user renamed the transcript', async () => {
    const { server, events, session } = awaiting(false)
    session.expectSubtitle()
    await session.setTitle('Mein Titel')
    // The subtitle is still awaited.
    expect(events.subscribers).toBe(1)
    server.stored = { ...server.stored, subtitle: 'KI-Zeile', subtitleSource: 'ai' }
    events.setOpen(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(events.subscribers).toBe(0)
    expect(server.deps.get).toHaveBeenCalledTimes(1)
    expect(session.getState().transcript).toMatchObject({
      title: 'Mein Titel',
      subtitle: 'KI-Zeile'
    })
  })
})

describe('ResultSession undo and optimisation', () => {
  it('undoes structural edits and saves the restoration', async () => {
    const server = fakeServer(transcript())
    const session = new ResultSession(server.stored, server.deps)
    rename(session, 1, 'Cem')
    expect(session.getState().undo).toHaveLength(1)
    expect(session.undo()).toBe(true)
    expect(session.getState().segments[1]!.speaker).toBe('Ben')
    expect(session.undo()).toBe(false)
    await session.flush()
    expect(server.stored.segments[1]!.speaker).toBe('Ben')
  })

  it('keeps text corrections out of the undo stack', () => {
    const server = fakeServer(transcript())
    const session = new ResultSession(server.stored, server.deps)
    session.edit(
      ({ segments }) => ({ segments: segments.map((segment) => ({ ...segment, text: 'x' })) }),
      { undoable: false }
    )
    expect(session.getState().undo).toHaveLength(0)
  })

  it('replaces the segments with the optimisation as an undoable edit', async () => {
    const server = fakeServer(transcript())
    const session = new ResultSession(server.stored, server.deps)
    expect(await session.optimizeSpeakers()).toEqual({ ok: true })
    expect(session.getState().segments.map((segment) => segment.speaker)).toEqual(['Anna', 'Anna'])
    expect(session.getState()).toMatchObject({ optimizing: false })
    session.undo()
    expect(session.getState().segments[1]!.speaker).toBe('Ben')
  })

  it('keeps edits made while the optimisation runs and only takes its speakers', async () => {
    const server = fakeServer(transcript())
    let answer: (value: { segments: TranscriptionTranscript['segments'] }) => void = () => {}
    server.deps.optimize = vi.fn(
      () =>
        new Promise<{ segments: TranscriptionTranscript['segments'] }>((resolve) => {
          answer = resolve
        })
    )
    const session = new ResultSession(server.stored, server.deps)
    const running = session.optimizeSpeakers()
    session.edit(
      ({ segments }) => ({
        segments: segments.map((segment, index) =>
          index === 0 ? { ...segment, text: 'Corrected during AI' } : segment
        )
      }),
      { undoable: false }
    )
    await session.flush()
    expect(server.stored.revision).toBe(2)
    answer({
      segments: transcript().segments.map((segment) => ({ ...segment, speaker: 'Ben' }))
    })
    expect(await running).toEqual({ ok: true })
    await session.flush()
    const segments = session.getState().segments
    // The corrected segment keeps the user's text and speaker; the untouched one is reassigned.
    expect(segments[0]).toMatchObject({ text: 'Corrected during AI', speaker: 'Anna' })
    expect(segments[1]).toMatchObject({ text: 'Tag.', speaker: 'Ben' })
    expect(server.stored.segments[0]!.text).toBe('Corrected during AI')
    expect(session.getState().saveStatus).toBe('saved')
  })

  it('reports an optimisation error with the server message', async () => {
    const server = fakeServer(transcript())
    server.deps.optimize = vi.fn(async () => {
      throw new ApiRequestError(502, {
        error: { code: 'module_unavailable', message: 'Modell nicht erreichbar' }
      })
    })
    const session = new ResultSession(server.stored, server.deps)
    expect(await session.optimizeSpeakers()).toEqual({
      ok: false,
      message: 'Modell nicht erreichbar'
    })
    expect(session.getState().undo).toHaveLength(0)
  })
})

describe('kept copies', () => {
  it('marks a session opened from the kept copy until the server answers', async () => {
    const server = fakeServer(transcript())
    const session = new ResultSession(server.stored, server.deps, false, true)
    expect(session.getState().keptCopy).toBe(true)
    rename(session, 1, 'Cem')
    await session.flush()
    expect(session.getState()).toMatchObject({ keptCopy: false, saveStatus: 'saved' })
  })
})

describe('text corrections', () => {
  it('keeps an emptied segment as an editable placeholder beside text of the same speaker', async () => {
    const server = fakeServer(
      transcript({ segments: [seg(0, 0, 5, 'One', 'Anna'), seg(1, 5, 10, 'Two', 'Anna')] })
    )
    const session = new ResultSession(server.stored, server.deps)
    session.edit(
      ({ segments }) => {
        const changed = updateSegmentText(segments, 0, '')
        return changed ? { segments: changed } : null
      },
      { undoable: false, cleanup: false }
    )
    await session.flush()
    const segments = session.getState().segments
    expect(segments).toHaveLength(2)
    expect(segments[0]).toMatchObject({ start: 0, end: 5, text: TRANSCRIPTION_EMPTY_SPEAKER_TEXT })
    expect(server.stored.segments[0]!.text).toBe(TRANSCRIPTION_EMPTY_SPEAKER_TEXT)
    // Typed in again, the text is back.
    session.edit(
      ({ segments: current }) => {
        const changed = updateSegmentText(current, 0, 'One again')
        return changed ? { segments: changed } : null
      },
      { undoable: false, cleanup: false }
    )
    expect(session.getState().segments[0]!.text).toBe('One again')
  })
})

describe('local transcripts', () => {
  it('stores edits locally instead of sending them', () => {
    const server = fakeServer(transcript({ id: 'local-1' }))
    const saveLocal = vi.fn<(changed: TranscriptionTranscript) => boolean>(() => true)
    const session = new ResultSession(server.stored, { ...server.deps, saveLocal }, true)
    rename(session, 1, 'Cem')
    expect(server.patches).toEqual([])
    expect(saveLocal).toHaveBeenCalledTimes(1)
    expect(saveLocal.mock.calls[0]![0].segments[1]!.speaker).toBe('Cem')
    expect(session.getState().saveStatus).toBe('saved')
    expect(session.hasUnsavedChanges()).toBe(false)
  })

  describe('when the browser storage refuses the change', () => {
    const key = localHistoryKey('module', 'alice')
    const map = new Map<string, string>()
    let full = false

    beforeEach(() => {
      full = false
      map.clear()
      vi.stubGlobal('window', {
        localStorage: {
          get length() {
            return map.size
          },
          key: (index: number) => [...map.keys()][index] ?? null,
          getItem: (name: string) => map.get(name) ?? null,
          setItem: (name: string, value: string) => {
            if (full) throw new DOMException('full', 'QuotaExceededError')
            map.set(name, value)
          },
          removeItem: (name: string) => void map.delete(name)
        }
      })
    })
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    /** The local session as the result view opens it, on the production storage. */
    function localSession(): ResultSession {
      const stored = transcript({ id: 'local-1', title: 'Group' })
      writeLocalHistory(key, [localRecord(stored)])
      const server = fakeServer(stored)
      return new ResultSession(
        stored,
        {
          ...server.deps,
          saveLocal: (changed) => saveLocalCopy(key, changed)
        },
        true
      )
    }

    it('keeps a title unsaved and retries it', async () => {
      const session = localSession()
      full = true
      expect(await session.setTitle('Lost edit')).toBe(false)
      expect(session.getState().transcript.title).toBe('Lost edit')
      expect(session.getState().saveStatus).toBe('failed')
      expect(session.hasUnsavedChanges()).toBe(true)
      expect(readLocalHistory(key)[0]!.title).toBe('Group')
      // Room again: the retry stores the title too.
      full = false
      session.retry()
      expect(session.getState().saveStatus).toBe('saved')
      expect(session.hasUnsavedChanges()).toBe(false)
      expect(readLocalHistory(key)[0]!.transcript!.title).toBe('Lost edit')
    })

    it('keeps edits and the subtitle unsaved until a later write succeeds', async () => {
      const session = localSession()
      full = true
      rename(session, 1, 'Cem')
      expect(await session.setSubtitle('Notiz')).toBe(false)
      expect(session.getState().saveStatus).toBe('failed')
      expect(session.hasUnsavedChanges()).toBe(true)
      expect(readLocalHistory(key)[0]!.transcript!.segments[1]!.speaker).toBe('Ben')
      full = false
      rename(session, 0, 'Dora')
      expect(session.getState().saveStatus).toBe('saved')
      const kept = readLocalHistory(key)[0]!.transcript!
      expect(kept.segments.map((segment) => segment.speaker)).toEqual(['Dora', 'Cem'])
      expect(kept.subtitle).toBe('Notiz')
    })

    describe('while a save of the same jobs is reconciled', () => {
      const jobA = '0b7c2a4e-6f4d-4b8e-9a51-1d1f1c3e5a77'
      const jobB = '9d3e2f1a-4b5c-4d6e-8f7a-1b2c3d4e5f60'
      const file = (
        name: string,
        jobId: string,
        startTime: number
      ): TranscriptionTranscriptCreate['sourceFiles'][number] => ({
        name,
        size: 12,
        duration: 5,
        startTime,
        endTime: startTime + 5,
        jobId
      })
      const groupA: TranscriptionTranscriptCreate = {
        idempotencyKey: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
        title: 'Group A',
        jobIds: [jobA],
        language: 'de',
        duration: 10,
        segments: [seg(0, 0, 5, 'Hallo.', 'Anna'), seg(1, 5, 10, 'Tag.', 'Ben')],
        sourceFiles: [file('a.wav', jobA, 0)]
      }
      /** A and B regrouped after A failed: another key, a larger group. */
      const groupAB: TranscriptionTranscriptCreate = {
        ...groupA,
        idempotencyKey: '3f2b1c8e-9d4a-4e6f-8b7c-5a1d2e3f4a5b',
        title: 'Group A+B',
        jobIds: [jobA, jobB],
        duration: 15,
        segments: [...groupA.segments, seg(2, 10, 15, 'Moin.', 'Cem')],
        sourceFiles: [file('a.wav', jobA, 0), file('b.wav', jobB, 10)]
      }
      const now = new Date('2026-10-04T12:00:00.000Z')
      const idA = localIdFor(groupA.idempotencyKey)
      const idAB = localIdFor(groupAB.idempotencyKey)
      let unregister: (() => void) | null = null

      afterEach(() => {
        unregister?.()
        unregister = null
      })

      /** The failed save of A kept locally and opened as the result view opens it. */
      function openFallbackA(register = true): ResultSession {
        changeLocalHistory(
          key,
          (records) =>
            recordSaveOutcome(records, { input: groupA, error: new Error('offline') }, now).records
        )
        const stored = readLocalHistory(key).find((record) => record.id === idA)!.transcript!
        const session = new ResultSession(
          stored,
          { ...fakeServer(stored).deps, saveLocal: (changed) => saveLocalCopy(key, changed) },
          true
        )
        if (register) unregister = registerOpenLocalCopy(idA, () => session.hasUnsavedChanges())
        return session
      }

      /** The save-fallback listener's step for a save outcome. */
      function reconcile(
        outcome: Parameters<typeof recordSaveOutcome>[1]
      ): SaveReconciliation | null {
        let result: SaveReconciliation | null = null
        changeLocalHistory(key, (records) => {
          result = recordSaveOutcome(records, outcome, now)
          return result.records
        })
        return result
      }

      const failAB = { input: groupAB, error: new Error('offline') }
      const stored = (id: string): LocalHistoryRecord | undefined =>
        readLocalHistory(key).find((record) => record.id === id)

      it('keeps an open copy whose title the storage refused when a larger group fails', async () => {
        const session = openFallbackA()
        full = true
        expect(await session.setTitle('Unsaved user edit')).toBe(false)
        full = false
        const result = reconcile(failAB)!
        expect(result.replaced).toEqual([])
        expect(readLocalHistory(key).map((record) => record.id)).toEqual([idAB, idA])
        expect(stored(idA)!.title).toBe('Group A')
        // The retry stores the edit in the copy that is still there.
        session.retry()
        expect(session.getState().saveStatus).toBe('saved')
        expect(session.hasUnsavedChanges()).toBe(false)
        expect(stored(idA)!.transcript!.title).toBe('Unsaved user edit')
        expect(stored(idAB)!.title).toBe('Group A+B')
      })

      it('keeps an open copy with refused segment edits, also when the save reaches the server', () => {
        const session = openFallbackA()
        full = true
        rename(session, 1, 'Dora')
        expect(session.hasUnsavedChanges()).toBe(true)
        full = false
        expect(reconcile(failAB)!.replaced).toEqual([])
        const saved = transcript({ id: '5d1e3c9a-2b4f-4a6e-8c7d-9e0f1a2b3c4d' })
        const success = reconcile({ input: groupA, transcript: saved })!
        expect(success.replaced).toEqual([])
        expect(success.kept).toEqual([idA])
        expect(stored(idA)!.pendingJobIds).toEqual([])
        session.retry()
        expect(session.hasUnsavedChanges()).toBe(false)
        expect(stored(idA)!.transcript!.segments.map((segment) => segment.speaker)).toEqual([
          'Anna',
          'Dora'
        ])
      })

      it('does not settle a title merge into the server while the open copy holds unsaved edits', () => {
        const session = openFallbackA()
        full = true
        rename(session, 0, 'Dora')
        full = false
        const merge = {
          localId: idA,
          transcriptId: 's-1',
          title: 'Group A',
          subtitle: null,
          stamp: `${stored(idA)!.updatedAt}|${stored(idA)!.transcript!.updatedAt}`
        }
        expect(settleTitleMerge(readLocalHistory(key), merge, true).outcome).toBe('kept')
      })

      it('still replaces the copy when it is not open, or open without unsaved edits', () => {
        openFallbackA(false)
        expect(reconcile(failAB)!.replaced).toEqual([{ localId: idA, transcriptId: idAB }])
        expect(readLocalHistory(key).map((record) => record.id)).toEqual([idAB])

        map.clear()
        const session = openFallbackA()
        rename(session, 1, 'Dora')
        // Stored: nothing only in memory, so the stored record speaks for it; edited, it stays.
        expect(session.hasUnsavedChanges()).toBe(false)
        expect(reconcile(failAB)!.replaced).toEqual([])
      })

      it('stores the whole document again when its record went meanwhile', async () => {
        const session = openFallbackA()
        full = true
        expect(await session.setTitle('Unsaved user edit')).toBe(false)
        rename(session, 1, 'Dora')
        full = false
        // Another tab's reconciliation removed it.
        changeLocalHistory(key, (records) => withoutRecord(records, idA))
        // Refused again: no success is claimed for a record that is not there.
        full = true
        session.retry()
        expect(session.getState().saveStatus).toBe('failed')
        expect(session.hasUnsavedChanges()).toBe(true)
        expect(stored(idA)).toBeUndefined()
        full = false
        session.retry()
        expect(session.getState().saveStatus).toBe('saved')
        expect(session.hasUnsavedChanges()).toBe(false)
        const back = stored(idA)!
        expect(back).toMatchObject({ local: true, title: 'Unsaved user edit', pendingJobIds: [] })
        expect(back.transcript!.segments.map((segment) => segment.speaker)).toEqual([
          'Anna',
          'Dora'
        ])
      })
    })
  })
})

describe('stableStringify', () => {
  it('ignores key order', () => {
    expect(stableStringify({ b: 1, a: [{ d: 1, c: 2 }] })).toBe(
      stableStringify({ a: [{ c: 2, d: 1 }], b: 1 })
    )
  })
})
