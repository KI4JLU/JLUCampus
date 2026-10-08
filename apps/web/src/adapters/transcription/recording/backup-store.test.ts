import { describe, expect, it } from 'vitest'
import {
  chunkName,
  createBackupJournal,
  isChunkName,
  listStoredRecordings,
  META_FILE,
  parseBackupMeta,
  readStoredRecording,
  removeStoredRecording,
  type BackupMeta,
  type StoreDirectory,
  type StoreFile
} from './backup-store'

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
