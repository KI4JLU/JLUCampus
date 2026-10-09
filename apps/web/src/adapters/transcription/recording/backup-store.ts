import type { SourceKind } from './sources'

/**
 * The crash backup of recorded takes in the browser's Origin Private File System: one
 * directory per take under `transcription-recordings/<id>/` with `meta.json` and numbered
 * chunk files, and the take's tracks, one per source, alike in `tracks/<track id>/` inside it
 * (takes backed up before tracks have none). A writable only commits on `close()`, so every few seconds the recorder's chunks
 * become one closed file; a crash or reload loses at most the last few seconds. The directory
 * stays until its take is uploaded or deleted; what is left over is offered again on the next
 * visit. A Web Lock per recording marks the ones a page still holds, so another tab never offers
 * (or discards) a recording that is running or kept there.
 */

export const BACKUP_DIRECTORY = 'transcription-recordings'
export const META_FILE = 'meta.json'
export const TRACKS_DIRECTORY = 'tracks'

/** About five seconds of audio at the recorder's one-second chunks. */
export const CHUNKS_PER_FILE = 5

const LOCK_PREFIX = 'justcampus-transcription-recording:'

export interface BackupMeta {
  id: string
  /** Milliseconds since the epoch. */
  startedAt: number
  filename: string
  mimeType: string
}

/** A track's `meta.json`: one source of a take, recorded on its own. */
export interface TrackBackupMeta {
  id: string
  /** The source's name. */
  label: string
  kind: SourceKind
  /** When the track started, in milliseconds since the epoch; the take's start is its offset 0. */
  startedAt: number
  /**
   * When it stopped capturing, written once it did; a track still running when the page went has
   * none. Its last chunk is stored later than that, so only this tells when it ended.
   */
  endedAt?: number
  mimeType: string
}

/** A track read back from the backup. */
export interface StoredTrack extends TrackBackupMeta {
  blob: Blob
  /** Seconds, from its start to its end, else to its last chunk written. */
  duration: number
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

/** A leftover recording as the record tab offers it. */
export interface StoredRecording extends BackupMeta {
  /** Bytes of all chunks. */
  size: number
  chunks: number
  /** Seconds, from the start to the last chunk written; `null` without chunks. */
  duration: number | null
}

/**
 * `chunk-000000.part`: zero-padded, so the names sort in recording order. The parts are in the
 * recorder's format, named in `meta.json`.
 */
export function chunkName(index: number): string {
  return `chunk-${String(index).padStart(6, '0')}.part`
}

export function isChunkName(name: string): boolean {
  return /^chunk-\d{6}\.part$/.test(name)
}

export function parseBackupMeta(text: string): BackupMeta | null {
  try {
    const value = JSON.parse(text) as Partial<BackupMeta> | null
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

export function parseTrackMeta(text: string): TrackBackupMeta | null {
  try {
    const value = JSON.parse(text) as Partial<TrackBackupMeta> | null
    if (
      typeof value?.id === 'string' &&
      typeof value.label === 'string' &&
      (value.kind === 'microphone' || value.kind === 'display') &&
      typeof value.startedAt === 'number' &&
      (value.endedAt === undefined || typeof value.endedAt === 'number') &&
      typeof value.mimeType === 'string'
    )
      return {
        id: value.id,
        label: value.label,
        kind: value.kind,
        startedAt: value.startedAt,
        ...(value.endedAt === undefined ? {} : { endedAt: value.endedAt }),
        mimeType: value.mimeType
      }
  } catch {
    // Not JSON.
  }
  return null
}

let root: Promise<StoreDirectory | null> | null = null

/** The backup's directory; `null` where the browser has no OPFS or refuses it. */
export function backupDirectory(): Promise<StoreDirectory | null> {
  root ??= (async () => {
    try {
      const storage = typeof navigator === 'undefined' ? undefined : navigator.storage
      if (!storage?.getDirectory) return null
      const origin = (await storage.getDirectory()) as unknown as StoreDirectory
      return await origin.getDirectoryHandle(BACKUP_DIRECTORY, { create: true })
    } catch {
      return null
    }
  })()
  return root
}

/**
 * The directory of a take's tracks, made with the take's own if it is not there yet; it rejects
 * when the storage refuses, which fails the track's backup alone.
 */
export async function trackDirectory(
  directory: Promise<StoreDirectory | null>,
  takeId: string
): Promise<StoreDirectory | null> {
  const parent = await directory
  if (!parent) return null
  const take = await parent.getDirectoryHandle(takeId, { create: true })
  return take.getDirectoryHandle(TRACKS_DIRECTORY, { create: true })
}

async function readText(folder: StoreDirectory, name: string): Promise<string> {
  return (await (await folder.getFileHandle(name)).getFile()).text()
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

export interface BackupJournal {
  /** One recorder chunk; every `CHUNKS_PER_FILE` of them are written as one file. */
  add: (chunk: Blob) => void
  /**
   * Writes what is pending, then `meta` over the first one if given, and waits for every write;
   * never rejects.
   */
  close: (meta?: BackupMeta | TrackBackupMeta) => Promise<void>
}

/**
 * Backs one recording, a take or one of its tracks, up while it runs, in `meta.id` below
 * `directory`. Writes run one after another through one promise chain.
 * Batches follow the recorder's chunks rather than a timer, since Chrome throttles timers of a
 * tab in the background, which is where this tab is while another tab's meeting is recorded. The
 * first failure (no OPFS, quota, a refused write) ends the backup and calls `onFailure` once; the
 * recording goes on.
 */
export function createBackupJournal(
  directory: Promise<StoreDirectory | null>,
  meta: BackupMeta | TrackBackupMeta,
  onFailure: () => void,
  chunksPerFile = CHUNKS_PER_FILE
): BackupJournal {
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
    close: (final) => {
      flush()
      if (final)
        chain = chain.then(async () => {
          if (failed) return
          try {
            await writeFile(await own, META_FILE, JSON.stringify(final))
          } catch {
            fail()
          }
        })
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
export async function listStoredRecordings(
  directory: StoreDirectory,
  skip: ReadonlySet<string> = new Set()
): Promise<StoredRecording[]> {
  const ids: string[] = []
  for await (const id of directory.keys()) if (!skip.has(id)) ids.push(id)
  const recordings: StoredRecording[] = []
  for (const id of ids) {
    const recording = await readStoredInfo(directory, id)
    if (recording) recordings.push(recording)
  }
  return recordings.sort((a, b) => a.startedAt - b.startedAt)
}

/** One recording as offered; `null` when it is gone or has no readable `meta.json`. */
export async function readStoredInfo(
  directory: StoreDirectory,
  id: string
): Promise<StoredRecording | null> {
  try {
    const folder = await directory.getDirectoryHandle(id)
    const meta = parseBackupMeta(
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
 * The recording's chunks as one blob in the recorder's format, in order. The bytes are copied into
 * memory: a blob backed by an OPFS file cannot be read once the backup is removed, and the upload
 * reads later.
 */
export async function readStoredRecording(directory: StoreDirectory, id: string): Promise<Blob> {
  const folder = await directory.getDirectoryHandle(id)
  const meta = parseBackupMeta(
    await (await (await folder.getFileHandle(META_FILE)).getFile()).text()
  )
  const parts: ArrayBuffer[] = []
  for (const name of await chunkNames(folder))
    parts.push(await (await (await folder.getFileHandle(name)).getFile()).arrayBuffer())
  return new Blob(parts, { type: meta?.mimeType ?? 'audio/webm' })
}

/**
 * A take's tracks in the backup, by start, each as one blob read into memory; a take backed up
 * before tracks, or without any, has none. Tracks that cannot be listed or read, or have no
 * chunk, are left out; it never rejects, so the take is restored however its tracks fare.
 */
export async function readStoredTracks(
  directory: StoreDirectory,
  takeId: string
): Promise<StoredTrack[]> {
  let folder: StoreDirectory
  try {
    folder = await (await directory.getDirectoryHandle(takeId)).getDirectoryHandle(TRACKS_DIRECTORY)
  } catch {
    return []
  }
  const ids: string[] = []
  try {
    for await (const id of folder.keys()) ids.push(id)
  } catch {
    // The tracks listed so far are read; the take comes back either way.
  }
  const tracks: StoredTrack[] = []
  for (const id of ids) {
    try {
      const track = await folder.getDirectoryHandle(id)
      const meta = parseTrackMeta(await readText(track, META_FILE))
      if (!meta || meta.id !== id) continue
      const names = await chunkNames(track)
      if (names.length === 0) continue
      const parts: ArrayBuffer[] = []
      let last = 0
      for (const name of names) {
        const file = await (await track.getFileHandle(name)).getFile()
        parts.push(await file.arrayBuffer())
        last = Math.max(last, file.lastModified)
      }
      tracks.push({
        ...meta,
        blob: new Blob(parts, { type: meta.mimeType }),
        duration: Math.max(0, ((meta.endedAt ?? last) - meta.startedAt) / 1000)
      })
    } catch {
      // Not offered, as a take that cannot be read.
    }
  }
  return tracks.sort((a, b) => a.startedAt - b.startedAt)
}

/** Removes a take's tracks from the backup, the take staying; none counts as removed. */
export async function removeStoredTracks(
  directory: Promise<StoreDirectory | null>,
  takeId: string
): Promise<void> {
  try {
    const take = await (await directory)?.getDirectoryHandle(takeId)
    await take?.removeEntry(TRACKS_DIRECTORY, { recursive: true })
  } catch {
    // None, or the storage refuses; they go with their take.
  }
}

/**
 * Removes a recording, with its tracks, from the backup; one that is gone already counts as
 * removed.
 */
export async function removeStoredRecording(
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
export function holdBackupLock(id: string): { held: Promise<void>; release: () => void } {
  const lock = holdLock(id, false)
  return { held: lock.acquired.then(() => undefined), release: lock.release }
}

/**
 * Takes the recording's lock if no page holds it: the release, else `null`. Without Web Locks
 * every recording counts as free.
 */
export async function claimBackupLock(id: string): Promise<(() => void) | null> {
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
export async function heldBackupIds(): Promise<Set<string>> {
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
