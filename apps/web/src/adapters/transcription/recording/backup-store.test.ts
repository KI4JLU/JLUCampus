import { describe, expect, it } from 'vitest'
import {
  chunkName,
  createBackupJournal,
  isChunkName,
  listStoredRecordings,
  META_FILE,
  parseBackupMeta,
  parseTrackMeta,
  readStoredRecording,
  readStoredTracks,
  removeStoredRecording,
  removeStoredTracks,
  trackDirectory,
  TRACKS_DIRECTORY,
  type BackupMeta,
  type TrackBackupMeta,
  type StoreDirectory,
  type StoreFile
} from './backup-store'
import { keepsTracks, trackOffset } from './tracks'

/** An in-memory OPFS directory: files commit on `close`, as in the browser. */
class FakeDirectory implements StoreDirectory {
  readonly folders = new Map<string, FakeDirectory>()
  readonly files = new Map<string, File>()
  /** Names whose writes fail, e.g. a full quota. */
  failing = new Set<string>()
  /** The time files are written at, shared with the folders inside. */
  clock = { now: 0 }

  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<StoreDirectory> {
    let folder = this.folders.get(name)
    if (!folder && options?.create) {
      folder = new FakeDirectory()
      folder.failing = this.failing
      folder.clock = this.clock
      this.folders.set(name, folder)
    }
    return folder ? Promise.resolve(folder) : Promise.reject(new Error('NotFoundError'))
  }

  getFileHandle(name: string, options?: { create?: boolean }): Promise<StoreFile> {
    if (!this.files.has(name) && !options?.create) return Promise.reject(new Error('NotFoundError'))
    const handle: StoreFile = {
      getFile: () => Promise.resolve(this.files.get(name) ?? new File([], name)),
      createWritable: () => {
        const parts: (Blob | string)[] = []
        return Promise.resolve({
          write: (data: Blob | string) => {
            if (this.failing.has(name)) return Promise.reject(new Error('QuotaExceededError'))
            parts.push(data)
            return Promise.resolve()
          },
          close: () => {
            this.files.set(name, new File(parts, name, { lastModified: this.clock.now }))
            return Promise.resolve()
          }
        })
      }
    }
    return Promise.resolve(handle)
  }

  removeEntry(name: string): Promise<void> {
    if (!this.folders.delete(name) && !this.files.delete(name))
      return Promise.reject(new Error('NotFoundError'))
    return Promise.resolve()
  }

  async *keys(): AsyncIterable<string> {
    await Promise.resolve()
    yield* [...this.folders.keys(), ...this.files.keys()]
  }
}

const meta: BackupMeta = {
  id: 'm1',
  startedAt: 1_000_000,
  filename: 'max-20261007-100000.webm',
  mimeType: 'audio/webm;codecs=opus'
}

const chunk = (text: string): Blob => new Blob([text])

describe('chunk names', () => {
  it('pads the index so the names sort in recording order', () => {
    expect(chunkName(0)).toBe('chunk-000000.part')
    expect(chunkName(12)).toBe('chunk-000012.part')
    expect([chunkName(10), chunkName(9), chunkName(100)].sort()).toEqual([
      chunkName(9),
      chunkName(10),
      chunkName(100)
    ])
    expect(isChunkName(chunkName(3))).toBe(true)
    expect(isChunkName(META_FILE)).toBe(false)
    expect(isChunkName('chunk-000001.part.crswap')).toBe(false)
  })
})

describe('parseBackupMeta', () => {
  it('reads valid metadata and refuses anything else', () => {
    expect(parseBackupMeta(JSON.stringify(meta))).toEqual(meta)
    expect(parseBackupMeta('{"id":"m1"}')).toBeNull()
    expect(parseBackupMeta('not json')).toBeNull()
    expect(parseBackupMeta('null')).toBeNull()
  })
})

describe('createBackupJournal', () => {
  it('writes the metadata, then every few chunks as one closed file', async () => {
    const root = new FakeDirectory()
    const journal = createBackupJournal(Promise.resolve(root), meta, () => undefined, 2)
    for (const text of ['a', 'b', 'c', 'd', 'e']) journal.add(chunk(text))
    await journal.close()
    const folder = root.folders.get('m1')!
    expect(parseBackupMeta(await folder.files.get(META_FILE)!.text())).toEqual(meta)
    expect(await folder.files.get(chunkName(0))!.text()).toBe('ab')
    expect(await folder.files.get(chunkName(1))!.text()).toBe('cd')
    // `close` writes what is left.
    expect(await folder.files.get(chunkName(2))!.text()).toBe('e')
  })

  it('writes the final metadata over the first one when closed with it', async () => {
    const root = new FakeDirectory()
    const journal = createBackupJournal(Promise.resolve(root), meta, () => undefined, 1)
    journal.add(chunk('a'))
    await journal.close({ ...meta, filename: 'renamed.webm' })
    const folder = root.folders.get('m1')!
    expect(parseBackupMeta(await folder.files.get(META_FILE)!.text())?.filename).toBe(
      'renamed.webm'
    )
    expect(await folder.files.get(chunkName(0))!.text()).toBe('a')
  })

  it('reports a failed write once and stops backing up', async () => {
    const root = new FakeDirectory()
    root.failing.add(chunkName(1))
    let failures = 0
    const journal = createBackupJournal(Promise.resolve(root), meta, () => failures++, 1)
    for (const text of ['a', 'b', 'c']) journal.add(chunk(text))
    await journal.close()
    expect(failures).toBe(1)
    expect([...root.folders.get('m1')!.files.keys()].sort()).toEqual([chunkName(0), META_FILE])
  })

  it('reports a missing storage without throwing', async () => {
    let failures = 0
    const journal = createBackupJournal(Promise.resolve(null), meta, () => failures++, 1)
    journal.add(chunk('a'))
    await expect(journal.close()).resolves.toBeUndefined()
    expect(failures).toBe(1)
  })
})

describe('stored recordings', () => {
  async function stored(root: FakeDirectory, at: number, id = meta.id): Promise<void> {
    const journal = createBackupJournal(
      Promise.resolve(root),
      { ...meta, id, startedAt: at },
      () => undefined,
      1
    )
    root.clock.now = at + 30_000
    journal.add(chunk('one-'))
    journal.add(chunk('two-'))
    root.clock.now = at + 61_000
    journal.add(chunk('three'))
    await journal.close()
  }

  it('lists leftovers with size and duration, skipping held ones and unreadable folders', async () => {
    const root = new FakeDirectory()
    await stored(root, 2_000_000, 'later')
    await stored(root, 1_000_000, 'earlier')
    await stored(root, 3_000_000, 'held')
    await root.getDirectoryHandle('broken', { create: true })
    const list = await listStoredRecordings(root, new Set(['held']))
    expect(list.map((entry) => entry.id)).toEqual(['earlier', 'later'])
    expect(list[0]).toMatchObject({ size: 13, chunks: 3, duration: 61 })
  })

  it('reads the chunks in order into one blob and removes the folder', async () => {
    const root = new FakeDirectory()
    await stored(root, 1_000_000)
    const blob = await readStoredRecording(root, meta.id)
    expect(await blob.text()).toBe('one-two-three')
    expect(blob.type).toBe(meta.mimeType)
    await removeStoredRecording(Promise.resolve(root), meta.id)
    expect(root.folders.size).toBe(0)
    // Removing again is no error.
    await expect(removeStoredRecording(Promise.resolve(root), meta.id)).resolves.toBeUndefined()
  })
})

describe('parseTrackMeta', () => {
  it('reads a track’s metadata and refuses anything else', () => {
    const track: TrackBackupMeta = {
      id: 't1',
      label: 'Headset',
      kind: 'microphone',
      startedAt: 1_000_000,
      mimeType: 'audio/webm'
    }
    expect(parseTrackMeta(JSON.stringify(track))).toEqual(track)
    const ended = { ...track, endedAt: 1_030_000 }
    expect(parseTrackMeta(JSON.stringify(ended))).toEqual(ended)
    expect(parseTrackMeta(JSON.stringify({ ...track, endedAt: 'soon' }))).toBeNull()
    expect(parseTrackMeta(JSON.stringify({ ...track, kind: 'camera' }))).toBeNull()
    expect(parseTrackMeta(JSON.stringify(meta))).toBeNull()
    expect(parseTrackMeta('not json')).toBeNull()
  })
})

describe('stored tracks', () => {
  const at = 1_000_000

  /** A take backed up from `at` with three chunks, its last written a minute in. */
  async function storedTake(root: FakeDirectory): Promise<void> {
    const journal = createBackupJournal(
      Promise.resolve(root),
      { ...meta, startedAt: at },
      () => undefined,
      1
    )
    root.clock.now = at + 60_000
    for (const text of ['one-', 'two-', 'three']) journal.add(chunk(text))
    await journal.close()
  }

  /** A track of the take from `startedAt`, its chunks written `seconds` after its start. */
  /**
   * A track of the take from `startedAt`, its chunks written `seconds` after its start; `endedAt`
   * as its recorder ended, none for one still running when the page went.
   */
  async function storedTrack(
    root: FakeDirectory,
    id: string,
    startedAt: number,
    seconds: number,
    texts: string[],
    endedAt?: number
  ): Promise<void> {
    const trackMeta: TrackBackupMeta = {
      id,
      label: `Track ${id}`,
      kind: 'microphone',
      startedAt,
      mimeType: 'audio/webm'
    }
    const journal = createBackupJournal(
      trackDirectory(Promise.resolve(root), meta.id),
      trackMeta,
      () => undefined,
      1
    )
    root.clock.now = startedAt + seconds * 1000
    for (const text of texts) journal.add(chunk(text))
    await journal.close(endedAt === undefined ? undefined : { ...trackMeta, endedAt })
  }

  it('backs tracks up inside their take, which lists and reads as before', async () => {
    const root = new FakeDirectory()
    await storedTake(root)
    await storedTrack(root, 'late', at + 12_000, 20, ['c', 'd'])
    await storedTrack(root, 'early', at, 60, ['a', 'b'])
    expect(root.folders.get(meta.id)!.folders.get(TRACKS_DIRECTORY)!.folders.size).toBe(2)
    // The take's size, chunks and audio are its own.
    const [listed] = await listStoredRecordings(root)
    expect(listed).toMatchObject({ id: meta.id, size: 13, chunks: 3, duration: 60 })
    expect(await (await readStoredRecording(root, meta.id)).text()).toBe('one-two-three')

    const tracks = await readStoredTracks(root, meta.id)
    expect(tracks.map((track) => [track.id, track.duration])).toEqual([
      ['early', 60],
      ['late', 20]
    ])
    expect(await tracks[1]!.blob.text()).toBe('cd')
    expect(tracks[1]).toMatchObject({
      label: 'Track late',
      kind: 'microphone',
      startedAt: at + 12_000
    })
  })

  it('takes a track’s end from when it stopped, not from when its last chunk was stored', async () => {
    const root = new FakeDirectory()
    await storedTake(root)
    // The microphone was swapped at 30 s; the old one's last chunk was stored a second later.
    await storedTrack(root, 'old', at, 31, ['a'], at + 30_000)
    // The new one still ran when the page went: its last stored chunk is all there is.
    await storedTrack(root, 'new', at + 30_000, 20, ['b'])
    const tracks = await readStoredTracks(root, meta.id)
    expect(tracks.map((track) => [track.id, track.endedAt, track.duration])).toEqual([
      ['old', at + 30_000, 30],
      ['new', undefined, 20]
    ])
    // One after the other: the restored take keeps no tracks.
    const spans = tracks.map((track) => ({
      offset: trackOffset(at, track.startedAt),
      duration: track.duration
    }))
    expect(keepsTracks(spans)).toBe(false)
  })

  it('restores what it can when the tracks cannot be listed', async () => {
    const root = new FakeDirectory()
    await storedTake(root)
    await storedTrack(root, 'a', at, 5, ['a'])
    await storedTrack(root, 'b', at, 5, ['b'])
    const folder = root.folders.get(meta.id)!.folders.get(TRACKS_DIRECTORY)!
    folder.keys = async function* () {
      await Promise.resolve()
      yield 'a'
      throw new Error('NotReadableError')
    }
    expect((await readStoredTracks(root, meta.id)).map((track) => track.id)).toEqual(['a'])
    folder.keys = async function* () {
      await Promise.resolve()
      yield* []
      throw new Error('NotReadableError')
    }
    await expect(readStoredTracks(root, meta.id)).resolves.toEqual([])
    // The take's own audio is untouched.
    expect(await (await readStoredRecording(root, meta.id)).text()).toBe('one-two-three')
  })

  it('reads a take backed up before tracks as one without any', async () => {
    const root = new FakeDirectory()
    await storedTake(root)
    expect(await readStoredTracks(root, meta.id)).toEqual([])
    expect(await readStoredTracks(root, 'gone')).toEqual([])
  })

  it('leaves out a track without chunks or readable metadata', async () => {
    const root = new FakeDirectory()
    await storedTake(root)
    await storedTrack(root, 'empty', at, 10, [])
    const tracks = await trackDirectory(Promise.resolve(root), meta.id)
    await tracks!.getDirectoryHandle('broken', { create: true })
    expect(await readStoredTracks(root, meta.id)).toEqual([])
  })

  it('fails a track’s backup alone when its write fails', async () => {
    const root = new FakeDirectory()
    await storedTake(root)
    root.failing.add(chunkName(0))
    let failures = 0
    const journal = createBackupJournal(
      trackDirectory(Promise.resolve(root), meta.id),
      { id: 't1', label: 'Tab', kind: 'display', startedAt: at, mimeType: 'audio/webm' },
      () => failures++,
      1
    )
    journal.add(chunk('x'))
    await journal.close()
    expect(failures).toBe(1)
    root.failing.clear()
    expect(await (await readStoredRecording(root, meta.id)).text()).toBe('one-two-three')
  })

  it('removes the tracks alone, or with their take', async () => {
    const root = new FakeDirectory()
    await storedTake(root)
    await storedTrack(root, 'a', at, 5, ['a'])
    await removeStoredTracks(Promise.resolve(root), meta.id)
    expect(await readStoredTracks(root, meta.id)).toEqual([])
    expect(await (await readStoredRecording(root, meta.id)).text()).toBe('one-two-three')
    // None left, or no take: no error.
    await expect(removeStoredTracks(Promise.resolve(root), meta.id)).resolves.toBeUndefined()
    await expect(removeStoredTracks(Promise.resolve(root), 'gone')).resolves.toBeUndefined()

    await storedTrack(root, 'b', at, 5, ['b'])
    await removeStoredRecording(Promise.resolve(root), meta.id)
    expect(root.folders.size).toBe(0)
  })
})
