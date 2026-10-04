import { DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import { objectKeys, TranscriptionStorage } from '../storage.js'

const state = vi.hoisted(() => ({
  /** Jobs that keep their objects, as `jobsKeepingObjects` finds them. */
  kept: [] as Array<{ id: string; componentId: string }>,
  asked: [] as string[][]
}))

vi.mock('./store.js', () => ({
  jobsKeepingObjects: async (ids: string[]) => {
    state.asked.push(ids)
    return state.kept.filter((row) => ids.includes(row.id))
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

beforeEach(() => {
  state.kept = [{ id: live, componentId: 'c' }]
  state.asked = []
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

  it('deletes the objects of deleted and expired jobs, which the query does not keep', async () => {
    // `jobsKeepingObjects` leaves out deleted and expired unsaved jobs; their objects go too.
    const { storage, bucket } = fakeS3({ [objectKeys.source('c', deleted)]: old })
    await sweepOrphanObjects(storage, null, now)
    expect(bucket.size).toBe(0)
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
