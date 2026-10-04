import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptionTranscript, TranscriptionTranscriptPatch } from '@justcampus/shared'
import { ApiRequestError } from '@/lib/api'
import { reassignBlock } from '../segments'
import { seg } from '../segments/test-fixtures'
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

describe('ResultSession AI subtitle polling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-04T10:01:00.000Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('fetches the detail up to five times, every two seconds', async () => {
    const server = fakeServer(transcript())
    const session = new ResultSession(server.stored, server.deps)
    session.expectSubtitle()
    session.expectSubtitle()
    expect(session.getState().awaitingSubtitle).toBe(true)
    await vi.advanceTimersByTimeAsync(2000 * 5)
    expect(server.deps.get).toHaveBeenCalledTimes(5)
    expect(session.getState().awaitingSubtitle).toBe(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(server.deps.get).toHaveBeenCalledTimes(5)
  })

  it('does not wait for a subtitle of an older transcript', () => {
    vi.setSystemTime(new Date('2026-10-05T10:00:00.000Z'))
    const server = fakeServer(transcript())
    const session = new ResultSession(server.stored, server.deps)
    session.expectSubtitle()
    expect(session.getState().awaitingSubtitle).toBe(false)
  })

  it('shows the subtitle once it arrives, unless the user typed one', async () => {
    const server = fakeServer(transcript())
    const session = new ResultSession(server.stored, server.deps)
    session.expectSubtitle()
    await vi.advanceTimersByTimeAsync(2000)
    // The module writes it without a new revision.
    server.stored = { ...server.stored, subtitle: 'KI-Zeile', subtitleSource: 'ai' }
    await vi.advanceTimersByTimeAsync(2000)
    expect(session.getState().transcript.subtitle).toBe('KI-Zeile')
    expect(session.getState().awaitingSubtitle).toBe(false)
    expect(server.deps.get).toHaveBeenCalledTimes(2)

    const other = fakeServer(transcript())
    const typed = new ResultSession(other.stored, other.deps)
    typed.expectSubtitle()
    typed.setEditingSubtitle(true)
    other.stored = { ...other.stored, subtitle: 'KI-Zeile', subtitleSource: 'ai', revision: 2 }
    await vi.advanceTimersByTimeAsync(2000)
    expect(typed.getState().transcript.subtitle).toBeNull()
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

describe('local transcripts', () => {
  it('stores edits locally instead of sending them', () => {
    const server = fakeServer(transcript({ id: 'local-1' }))
    const saveLocal = vi.fn()
    const session = new ResultSession(server.stored, { ...server.deps, saveLocal }, true)
    rename(session, 1, 'Cem')
    expect(server.patches).toEqual([])
    expect(saveLocal).toHaveBeenCalledTimes(1)
    expect(saveLocal.mock.calls[0]![0].segments[1].speaker).toBe('Cem')
    expect(session.getState().saveStatus).toBe('saved')
  })
})

describe('stableStringify', () => {
  it('ignores key order', () => {
    expect(stableStringify({ b: 1, a: [{ d: 1, c: 2 }] })).toBe(
      stableStringify({ a: [{ c: 2, d: 1 }], b: 1 })
    )
  })
})
