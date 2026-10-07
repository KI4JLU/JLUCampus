/**
 * The crash backup of meeting recordings in the browser's Origin Private File System: one
 * directory per recording under `transcription-meetings/<id>/` with `meta.json` and numbered
 * chunk files. A writable only commits on `close()`, so every few seconds the recorder's chunks
 * become one closed file; a crash or reload loses at most the last few seconds. The directory
 * stays until its take is uploaded or deleted; what is left over is offered again on the next
 * visit. A Web Lock per recording marks the ones a page still holds, so another tab never offers
 * (or discards) a recording that is running or kept there.
 */

export const MEETINGS_DIRECTORY = 'transcription-meetings'
export const META_FILE = 'meta.json'

/** About five seconds of audio at the recorder's one-second chunks. */
export const CHUNKS_PER_FILE = 5

const LOCK_PREFIX = 'justcampus-transcription-meeting:'

export interface MeetingMeta {
  id: string
  /** Milliseconds since the epoch. */
  startedAt: number
  filename: string
  mimeType: string
}

/** What the backup needs of an OPFS file; the tests fake it. */
export interface StoreFile {
  getFile: () => Promise<File>
  createWritable: () => Promise<{
    write: (data: Blob | string) => Promise<void>
    close: () => Promise<void>
  }>
}

/** What the backup needs of an OPFS directory; the tests fake it. */
export interface StoreDirectory {
  getDirectoryHandle: (name: string, options?: { create?: boolean }) => Promise<StoreDirectory>
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<StoreFile>
  removeEntry: (name: string, options?: { recursive?: boolean }) => Promise<void>
  keys: () => AsyncIterable<string>
}

/** A leftover recording as the meeting tab offers it. */
export interface StoredMeeting extends MeetingMeta {
  /** Bytes of all chunks. */
  size: number
  chunks: number
  /** Seconds, from the start to the last chunk written; `null` without chunks. */
  duration: number | null
}

/** `chunk-000000.webm`: zero-padded, so the names sort in recording order. */
export function chunkName(index: number): string {
  return `chunk-${String(index).padStart(6, '0')}.webm`
}

export function isChunkName(name: string): boolean {
  return /^chunk-\d{6}\.webm$/.test(name)
}

export function parseMeetingMeta(text: string): MeetingMeta | null {
  try {
    const value = JSON.parse(text) as Partial<MeetingMeta> | null
    if (
      typeof value?.id === 'string' &&
      typeof value.startedAt === 'number' &&
      typeof value.filename === 'string' &&
      typeof value.mimeType === 'string'
    )
      return {
        id: value.id,
        startedAt: value.startedAt,
        filename: value.filename,
        mimeType: value.mimeType
      }
  } catch {
    // Not JSON.
  }
  return null
}

let root: Promise<StoreDirectory | null> | null = null

/** The backup's directory; `null` where the browser has no OPFS or refuses it. */
export function meetingsDirectory(): Promise<StoreDirectory | null> {
  root ??= (async () => {
    try {
      const storage = typeof navigator === 'undefined' ? undefined : navigator.storage
      if (!storage?.getDirectory) return null
      const origin = (await storage.getDirectory()) as unknown as StoreDirectory
      return await origin.getDirectoryHandle(MEETINGS_DIRECTORY, { create: true })
    } catch {
      return null
    }
  })()
  return root
}

async function writeFile(
  directory: StoreDirectory,
  name: string,
  data: Blob | string
): Promise<void> {
  const handle = await directory.getFileHandle(name, { create: true })
  const writable = await handle.createWritable()
  await writable.write(data)
  await writable.close()
}

export interface MeetingJournal {
  /** One recorder chunk; every `CHUNKS_PER_FILE` of them are written as one file. */
  add: (chunk: Blob) => void
  /** Writes what is pending and waits for every write; never rejects. */
  close: () => Promise<void>
}

/**
 * Backs one recording up while it runs. Writes run one after another through one promise chain.
 * Batches follow the recorder's chunks rather than a timer, since Chrome throttles timers of a
 * tab in the background, which is where this tab is during a meeting. The first failure (no OPFS,
 * quota, a refused write) ends the backup and calls `onFailure` once; the recording goes on.
 */
export function createMeetingJournal(
  directory: Promise<StoreDirectory | null>,
  meta: MeetingMeta,
  onFailure: () => void,
  chunksPerFile = CHUNKS_PER_FILE
): MeetingJournal {
  let failed = false
  let index = 0
  let pending: Blob[] = []
  const fail = (): void => {
    if (failed) return
    failed = true
    pending = []
    onFailure()
  }
  const own = directory.then(async (parent) => {
    if (!parent) throw new Error('No storage for the backup')
    const folder = await parent.getDirectoryHandle(meta.id, { create: true })
    await writeFile(folder, META_FILE, JSON.stringify(meta))
    return folder
  })
  let chain: Promise<void> = own.then(
    () => undefined,
    () => fail()
  )
  const flush = (): void => {
    if (failed || pending.length === 0) return
    const data = new Blob(pending, { type: meta.mimeType })
    const name = chunkName(index++)
    pending = []
    chain = chain.then(async () => {
      if (failed) return
      try {
        await writeFile(await own, name, data)
      } catch {
        fail()
      }
    })
  }
  return {
    add: (chunk) => {
      if (failed) return
      pending.push(chunk)
      if (pending.length >= chunksPerFile) flush()
    },
    close: () => {
      flush()
      return chain
    }
  }
}

/** The chunk files of a recording directory in recording order. */
async function chunkNames(folder: StoreDirectory): Promise<string[]> {
  const names: string[] = []
  for await (const name of folder.keys()) if (isChunkName(name)) names.push(name)
  return names.sort()
}

/**
 * Every recording in the backup that `skip` does not name, oldest first. Directories without a
 * readable `meta.json` are left alone.
 */
export async function listStoredMeetings(
  directory: StoreDirectory,
  skip: ReadonlySet<string> = new Set()
): Promise<StoredMeeting[]> {
  const ids: string[] = []
  for await (const id of directory.keys()) if (!skip.has(id)) ids.push(id)
  const meetings: StoredMeeting[] = []
  for (const id of ids) {
    const meeting = await readMeetingInfo(directory, id)
    if (meeting) meetings.push(meeting)
  }
  return meetings.sort((a, b) => a.startedAt - b.startedAt)
}

/** One recording as offered; `null` when it is gone or has no readable `meta.json`. */
export async function readMeetingInfo(
  directory: StoreDirectory,
  id: string
): Promise<StoredMeeting | null> {
  try {
    const folder = await directory.getDirectoryHandle(id)
    const meta = parseMeetingMeta(
      await (await (await folder.getFileHandle(META_FILE)).getFile()).text()
    )
    if (!meta || meta.id !== id) return null
    let size = 0
    let last = 0
    const names = await chunkNames(folder)
    for (const name of names) {
      const file = await (await folder.getFileHandle(name)).getFile()
      size += file.size
      last = Math.max(last, file.lastModified)
    }
    return {
      ...meta,
      size,
      chunks: names.length,
      duration: names.length > 0 ? Math.max(0, (last - meta.startedAt) / 1000) : null
    }
  } catch {
    // A directory that vanished or cannot be read is not offered.
    return null
  }
}

/**
 * The recording's chunks as one WebM blob, in order. The bytes are copied into memory: a blob
 * backed by an OPFS file cannot be read once the backup is removed, and the upload reads later.
 */
export async function readStoredMeeting(directory: StoreDirectory, id: string): Promise<Blob> {
  const folder = await directory.getDirectoryHandle(id)
  const meta = parseMeetingMeta(
    await (await (await folder.getFileHandle(META_FILE)).getFile()).text()
  )
  const parts: ArrayBuffer[] = []
  for (const name of await chunkNames(folder))
    parts.push(await (await (await folder.getFileHandle(name)).getFile()).arrayBuffer())
  return new Blob(parts, { type: meta?.mimeType ?? 'audio/webm' })
}

/** Removes a recording from the backup; one that is gone already counts as removed. */
export async function removeStoredMeeting(
  directory: Promise<StoreDirectory | null>,
  id: string
): Promise<void> {
  try {
    await (await directory)?.removeEntry(id, { recursive: true })
  } catch {
    // Gone already, or the storage refuses; the next visit offers it again.
  }
}

/**
 * Holds the recording's lock until `release`; without Web Locks it does nothing. The lock is
 * granted asynchronously: `held` resolves once it is, and the backup's first write waits for it,
 * so another tab never sees the new directory unlocked.
 */
export function holdMeetingLock(id: string): { held: Promise<void>; release: () => void } {
  const lock = holdLock(id, false)
  return { held: lock.acquired.then(() => undefined), release: lock.release }
}

/**
 * Takes the recording's lock if no page holds it: the release, else `null`. Without Web Locks
 * every recording counts as free.
 */
export async function claimMeetingLock(id: string): Promise<(() => void) | null> {
  const lock = holdLock(id, true)
  return (await lock.acquired) ? lock.release : null
}

function holdLock(
  id: string,
  ifAvailable: boolean
): { acquired: Promise<boolean>; release: () => void } {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
  if (!locks) return { acquired: Promise.resolve(true), release: () => undefined }
  let release: () => void = () => undefined
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  let report: (acquired: boolean) => void = () => undefined
  const acquired = new Promise<boolean>((resolve) => {
    report = resolve
  })
  void locks
    .request(LOCK_PREFIX + id, { ifAvailable }, (lock) => {
      report(lock !== null)
      return lock ? released : undefined
    })
    .catch(() => report(true))
  return { acquired, release }
}

/** The recordings some page holds, in any tab of this browser profile. */
export async function heldMeetingIds(): Promise<Set<string>> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
  if (!locks) return new Set()
  try {
    const { held = [] } = await locks.query()
    return new Set(
      held
        .map((lock) => lock.name ?? '')
        .filter((name) => name.startsWith(LOCK_PREFIX))
        .map((name) => name.slice(LOCK_PREFIX.length))
    )
  } catch {
    return new Set()
  }
}
