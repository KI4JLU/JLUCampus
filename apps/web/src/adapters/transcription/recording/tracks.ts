import type { BackupJournal } from './backup-store'
import type { RecordedTrack } from './context'
import type { LocalRecorder } from './local-recorder'
import type { SourceKind } from './sources'

/**
 * The tracks of a regular recording: each source in the mix is also recorded on its own, from
 * the moment it joins the mix until it leaves it, so a take of several sources can be heard and
 * downloaded source by source. Only the mix is uploaded. A take whose sources never sounded at
 * the same time keeps no tracks: its mix is them, one after another.
 */

/** Where a track lies in its take, in seconds of the take's running time. */
export interface TrackSpan {
  offset: number
  duration: number
}

/** A track recorded to its end. */
export interface FinishedTrack extends TrackSpan {
  id: string
  label: string
  kind: SourceKind
  blob: Blob
}

/** The recorder of a track and its backup; the backup is `null` where it could not start. */
export interface TrackRecording {
  recorder: LocalRecorder
  journal: BackupJournal | null
}

/** What a track starts with, for its recorder and its backup. */
export interface TrackStart {
  id: string
  label: string
  kind: SourceKind
  /** Milliseconds since the epoch. */
  startedAt: number
}

/** Seconds from the take's start to `at`, both in milliseconds since the epoch; never negative. */
export function trackOffset(takeStartedAt: number, at: number): number {
  return Math.max(0, (at - takeStartedAt) / 1000)
}

/**
 * Whether a take keeps its tracks: only when two of them sounded at the same time. One source,
 * or one microphone swapped for another, is what the mix holds already.
 */
export function keepsTracks(tracks: readonly TrackSpan[]): boolean {
  const sorted = [...tracks].sort((a, b) => a.offset - b.offset)
  let end = -Infinity
  for (const track of sorted) {
    if (track.offset < end) return true
    end = Math.max(end, track.offset + track.duration)
  }
  return false
}

/**
 * A track's file name: the take's, before its extension, with the track's number and its
 * source's name in characters a file name carries, e.g. `max-20261008-101500-2-iphone.webm`.
 */
export function trackFilename(takeFilename: string, number: number, label: string): string {
  const dot = takeFilename.lastIndexOf('.')
  const base = dot > 0 ? takeFilename.slice(0, dot) : takeFilename
  const extension = dot > 0 ? takeFilename.slice(dot) : ''
  const name = label
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return `${base}-${number}${name ? `-${name}` : ''}${extension}`
}

/**
 * A take's tracks as files named and typed after the take's, numbered by start; none unless the
 * take `keepsTracks`.
 */
export function trackFiles(
  takeFilename: string,
  type: string,
  tracks: readonly FinishedTrack[]
): RecordedTrack[] | undefined {
  if (!keepsTracks(tracks)) return undefined
  return [...tracks]
    .sort((a, b) => a.offset - b.offset)
    .map((track, index) => ({
      id: track.id,
      file: new File([track.blob], trackFilename(takeFilename, index + 1, track.label), { type }),
      label: track.label,
      kind: track.kind,
      offset: track.offset,
      duration: track.duration
    }))
}

interface RunningTrack extends TrackStart {
  recording: TrackRecording
}

/**
 * The running take's tracks, by stream: a stream is one source, also when it moves from an added
 * microphone to the main one. `open` starts a track's recorder and backup and may throw; the take
 * then goes on without that track.
 */
export class TakeTracks {
  private readonly running = new Map<MediaStream, RunningTrack>()
  private readonly ended: Promise<FinishedTrack | null>[] = []
  /** Finished or discarded: a source that joins while the take ends gets no track. */
  private closed = false

  constructor(
    private readonly takeStartedAt: number,
    private readonly open: (stream: MediaStream, start: TrackStart) => TrackRecording,
    private readonly now: () => number = Date.now,
    private readonly newId: () => string = () => crypto.randomUUID()
  ) {}

  /** Records `stream` as a track from now on, unless it is one already. */
  start(stream: MediaStream, label: string, kind: SourceKind): void {
    if (this.closed || this.running.has(stream)) return
    const start: TrackStart = { id: this.newId(), label, kind, startedAt: this.now() }
    let recording: TrackRecording
    try {
      recording = this.open(stream, start)
    } catch {
      return
    }
    this.running.set(stream, { ...start, recording })
  }

  /** Ends the track of `stream`; call it before the stream is released. */
  stop(stream: MediaStream): void {
    const track = this.running.get(stream)
    if (!track) return
    this.running.delete(stream)
    const duration = (this.now() - track.startedAt) / 1000
    const { recorder, journal } = track.recording
    this.ended.push(
      recorder.stop().then(
        async (blob) => {
          // The backup gets the last chunk, which comes before the recorder's end.
          await journal?.close()
          if (blob.size === 0) return null
          const offset = trackOffset(this.takeStartedAt, track.startedAt)
          return { id: track.id, label: track.label, kind: track.kind, offset, duration, blob }
        },
        async () => {
          await journal?.close()
          return null
        }
      )
    )
  }

  /** Ends every track; resolves with those recorded, by start. */
  async finish(): Promise<FinishedTrack[]> {
    this.closed = true
    for (const stream of [...this.running.keys()]) this.stop(stream)
    const finished = await Promise.all(this.ended)
    return finished
      .filter((track): track is FinishedTrack => track !== null)
      .sort((a, b) => a.offset - b.offset)
  }

  /** Drops every track, e.g. when the page goes; their backups get their last chunks. */
  async discard(): Promise<void> {
    this.closed = true
    const running = [...this.running.values()]
    this.running.clear()
    await Promise.all([
      ...running.map(async ({ recording }) => {
        await recording.recorder.discard()
        await recording.journal?.close()
      }),
      ...this.ended
    ])
  }
}
