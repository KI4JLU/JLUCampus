import { DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import { objectKeys, TranscriptionStorage } from '../storage.js'

/** A job row as far as these tests look at it. */
interface Row {
  id: string
  componentId: string
  transcriptId: string | null
  expiresAt: Date | null
  deletedAt: Date | null
}

const state = vi.hoisted(() => ({
  /** The jobs table: whatever rows exist, in any state. */
  rows: [] as Row[],
  asked: [] as string[][],
  /** Runs right after the existence query answered, as a concurrent request would. */
  afterQuery: null as (() => void) | null
}))

vi.mock('./store.js', () => ({
  existingJobs: async (ids: string[]) => {
    state.asked.push(ids)
    const found = state.rows
      .filter((row) => ids.includes(row.id))
      .map(({ id, componentId }) => ({ id, componentId }))
    state.afterQuery?.()
    return found
  }
}))

const { ORPHAN_MIN_AGE_MS, sweepOrphanObjects } = await import('./orphans.js')

const now = new Date('2026-10-04T12:00:00.000Z')
const old = new Date(now.getTime() - ORPHAN_MIN_AGE_MS - 1000)
const fresh = new Date(now.getTime() - 60_000)
const live = '11111111-1111-4111-8111-111111111111'
const gone = '22222222-2222-4222-8222-222222222222'
const deleted = '33333333-3333-4333-8333-333333333333'

/** An S3 bucket in memory that answers `ListObjectsV2` and `DeleteObjects` as S3 does. */
interface FakeS3 {
  storage: TranscriptionStorage
  bucket: Map<string, Date | null>
  send: Mock<(command: unknown) => Promise<Record<string, unknown>>>
}

function fakeS3(objects: Record<string, Date | null>, refuse: string[] = []): FakeS3 {
  const bucket = new Map(Object.entries(objects))
  const storage = new TranscriptionStorage({
    endpoint: 'http://minio:9000',
    publicEndpoint: 'http://minio:9000',
    region: 'us-east-1',
    bucket: 'b',
    accessKeyId: 'access',
    secretAccessKey: 'secret',
    forcePathStyle: true
  })
  const send = vi.fn(async (command: unknown): Promise<Record<string, unknown>> => {
    if (command instanceof ListObjectsV2Command) {
      const { Prefix = '', StartAfter = '', MaxKeys = 1000 } = command.input
      const keys = [...bucket.keys()]
        .filter((key) => key.startsWith(Prefix) && key > StartAfter)
        .sort()
      return {
        Contents: keys.slice(0, MaxKeys).map((Key) => ({
          Key,
          LastModified: bucket.get(Key) ?? undefined
        })),
        IsTruncated: keys.length > MaxKeys
      }
    }
    if (command instanceof DeleteObjectsCommand) {
      const Errors = []
      for (const { Key } of command.input.Delete?.Objects ?? []) {
        if (refuse.includes(Key!)) Errors.push({ Key, Code: 'AccessDenied' })
        else bucket.delete(Key!)
      }
      return { Errors }
    }
    throw new Error('unexpected command')
  })
  ;(storage as unknown as { internal: { send: typeof send } }).internal.send = send
  return { storage, bucket, send }
}

function row(id: string, changes: Partial<Row> = {}): Row {
  return {
    id,
    componentId: 'c',
    transcriptId: null,
    expiresAt: new Date(now.getTime() + 3_600_000),
    deletedAt: null,
    ...changes
  }
}

beforeEach(() => {
  state.rows = [row(live)]
  state.asked = []
  state.afterQuery = null
})

describe('sweepOrphanObjects (T-08)', () => {
  it('deletes what a late upload stored after its job was deleted and purged', async () => {
    // The job row is gone; the browser's slow PUT only finished afterwards.
    const { storage, bucket } = fakeS3({
      [objectKeys.source('c', live)]: old,
      [objectKeys.peaks('c', live)]: old,
      [objectKeys.source('c', gone)]: old,
      [objectKeys.chunk('c', gone, 0)]: old
    })
    const sweep = await sweepOrphanObjects(storage, null, now)
    expect(sweep).toEqual({ cursor: null, deleted: 2 })
    expect([...bucket.keys()]).toEqual([objectKeys.source('c', live), objectKeys.peaks('c', live)])
    expect(state.asked).toEqual([[live, gone]])
  })

  it('leaves the objects of deleted and expired jobs whose row exists to the job cleanup', async () => {
    // `sweepJobs` claims such a job before deleting its objects; until then it may be saved.
    state.rows.push(
      row(deleted, { deletedAt: old }),
      row(gone, { expiresAt: old, transcriptId: null })
    )
    const { storage, bucket } = fakeS3({
      [objectKeys.source('c', deleted)]: old,
      [objectKeys.source('c', gone)]: old
    })
    const sweep = await sweepOrphanObjects(storage, null, now)
    expect(sweep.deleted).toBe(0)
    expect(bucket.size).toBe(2)
  })

  it('keeps the audio of an expired job saved between its query and the deletion (F-2)', async () => {
    // The job expired unsaved; the user's save commits after the sweep looked the job up.
    const expired = row(gone, { expiresAt: old })
    state.rows.push(expired)
    state.afterQuery = () => {
      expired.transcriptId = '55555555-5555-4555-8555-555555555555'
      expired.expiresAt = null
    }
    const late = '66666666-6666-4666-8666-666666666666'
    const { storage, bucket } = fakeS3({
      [objectKeys.source('c', gone)]: old,
      [objectKeys.normalized('c', gone)]: old,
      [objectKeys.peaks('c', gone)]: old,
      [objectKeys.sample('c', gone, 'speaker-0')]: old,
      // A late upload of a purged job in the same page still goes (U3-2).
      [objectKeys.source('c', late)]: old
    })
    const sweep = await sweepOrphanObjects(storage, null, now)
    expect(sweep.deleted).toBe(1)
    expect([...bucket.keys()].sort()).toEqual(
      [
        objectKeys.source('c', gone),
        objectKeys.normalized('c', gone),
        objectKeys.peaks('c', gone),
        objectKeys.sample('c', gone, 'speaker-0')
      ].sort()
    )
  })

  it('keeps the source of a job whose analysis extends its expiry after the query (F-2)', async () => {
    // The analysis read the job while live, waited for storage, and queues it only now.
    const expiring = row(gone, { expiresAt: old })
    state.rows.push(expiring)
    state.afterQuery = () => {
      expiring.expiresAt = new Date(now.getTime() + 24 * 3_600_000)
    }
    const { storage, bucket } = fakeS3({ [objectKeys.source('c', gone)]: old })
    const sweep = await sweepOrphanObjects(storage, null, now)
    expect(sweep.deleted).toBe(0)
    expect(bucket.has(objectKeys.source('c', gone))).toBe(true)
  })

  it('leaves recent objects, objects of unknown age and keys outside a job alone', async () => {
    const { storage, bucket } = fakeS3({
      [objectKeys.source('c', gone)]: fresh,
      [objectKeys.normalized('c', gone)]: null,
      'transcription/c/connection-tests/x.txt': old,
      'transcription/c/jobs/not-a-job/source': old
    })
    const sweep = await sweepOrphanObjects(storage, null, now)
    expect(sweep.deleted).toBe(0)
    expect(bucket.size).toBe(4)
  })

  it('does not take a job of another component for the owner of a key', async () => {
    const { storage, bucket } = fakeS3({ [objectKeys.source('other', live)]: old })
    await sweepOrphanObjects(storage, null, now)
    expect(bucket.size).toBe(0)
  })

  it('reads one page per sweep and goes on where the last one stopped', async () => {
    const objects: Record<string, Date> = {}
    for (let index = 0; index < 5; index++) {
      const id = `4444444${index}-4444-4444-8444-444444444444`
      objects[objectKeys.source('c', id)] = old
    }
    objects[objectKeys.source('c', live)] = old
    const { storage, bucket, send } = fakeS3(objects)
    let cursor: string | null = null
    const deletedPerSweep: number[] = []
    for (let sweep = 0; sweep < 3; sweep++) {
      const result = await sweepOrphanObjects(storage, cursor, now, 2)
      deletedPerSweep.push(result.deleted)
      cursor = result.cursor
    }
    // Pages of two keys: the live job sorts first, so the passes delete 1, 2 and 2 objects.
    expect(deletedPerSweep).toEqual([1, 2, 2])
    expect(cursor).toBeNull()
    expect([...bucket.keys()]).toEqual([objectKeys.source('c', live)])
    const listings = send.mock.calls.filter(([command]) => command instanceof ListObjectsV2Command)
    expect(listings.map(([command]) => (command as ListObjectsV2Command).input.MaxKeys)).toEqual([
      2, 2, 2
    ])
  })

  it('keeps what storage refused to delete for the next pass', async () => {
    const key = objectKeys.source('c', gone)
    const { storage, bucket } = fakeS3({ [key]: old }, [key])
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const sweep = await sweepOrphanObjects(storage, null, now)
    expect(sweep.deleted).toBe(0)
    expect(bucket.has(key)).toBe(true)
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})
