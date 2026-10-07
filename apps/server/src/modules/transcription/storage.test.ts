import { DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'

import {
  jobOfKey,
  objectKeys,
  PartialDeleteError,
  storageSettingsFromEnv,
  TranscriptionStorage
} from './storage.js'

const storage = new TranscriptionStorage({
  endpoint: 'http://minio:9000',
  region: 'us-east-1',
  bucket: 'justcampus-transcription',
  accessKeyId: 'access',
  secretAccessKey: 'secret',
  forcePathStyle: true
})
const now = new Date('2026-10-04T08:00:00.000Z')

describe('TranscriptionStorage', () => {
  it('sends Content-MD5 with a multi-delete, as older MinIO releases require', async () => {
    const seen: Array<{ md5: string | undefined; body: string }> = []
    const server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        seen.push({
          md5: request.headers['content-md5'] as string | undefined,
          body: Buffer.concat(chunks).toString()
        })
        response.writeHead(200, { 'Content-Type': 'application/xml' })
        response.end('<?xml version="1.0" encoding="UTF-8"?><DeleteResult></DeleteResult>')
      })
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    try {
      const local = new TranscriptionStorage({
        endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        region: 'us-east-1',
        bucket: 'b',
        accessKeyId: 'access',
        secretAccessKey: 'secret',
        forcePathStyle: true
      })
      expect(await local.deleteObjects(['job/source', 'job/normalized.wav'])).toEqual([])
      expect(seen).toHaveLength(1)
      expect(seen[0]!.body).toContain('job/normalized.wav')
      expect(seen[0]!.md5).toBe(createHash('md5').update(seen[0]!.body).digest('base64'))
    } finally {
      server.close()
    }
  })

  it('refuses to delete a prefix that is not a folder', async () => {
    await expect(storage.deletePrefix('transcription/c/jobs/j')).rejects.toThrow('must end with')
  })

  it('reports objects S3 refused to delete instead of counting them', async () => {
    const stubbed = new TranscriptionStorage({
      endpoint: 'http://minio:9000',
      region: 'us-east-1',
      bucket: 'b',
      accessKeyId: 'access',
      secretAccessKey: 'secret',
      forcePathStyle: true
    })
    const send = vi.fn(async (command: unknown): Promise<Record<string, unknown>> => {
      if (command instanceof ListObjectsV2Command) {
        return { Contents: [{ Key: 'job/source' }, { Key: 'job/normalized.wav' }] }
      }
      if (command instanceof DeleteObjectsCommand) {
        return { Errors: [{ Key: 'job/source', Code: 'AccessDenied' }] }
      }
      throw new Error('unexpected command')
    })
    ;(stubbed as unknown as { internal: { send: typeof send } }).internal.send = send
    const failure = await stubbed.deletePrefix('job/').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(PartialDeleteError)
    expect((failure as PartialDeleteError).failures).toEqual([
      { key: 'job/source', code: 'AccessDenied' }
    ])
    expect(send).toHaveBeenCalledTimes(2)

    send.mockImplementation(async (command: unknown) =>
      command instanceof ListObjectsV2Command ? { Contents: [{ Key: 'job/source' }] } : {}
    )
    await expect(stubbed.deletePrefix('job/')).resolves.toBe(1)
  })
})

describe('listing (orphan sweep, T-08)', () => {
  it('lists one page from after a key, with modification times', async () => {
    let listed: unknown
    const send = vi.fn(async (command: unknown) => {
      listed = command
      return {
        Contents: [{ Key: 'transcription/c/jobs/j/source', LastModified: now }, {}],
        IsTruncated: true
      }
    })
    ;(storage as unknown as { internal: { send: typeof send } }).internal.send = send
    const page = await storage.listObjects(objectKeys.root, { startAfter: 'a', maxKeys: 2 })
    expect(page).toEqual({
      objects: [{ key: 'transcription/c/jobs/j/source', lastModified: now }],
      truncated: true
    })
    expect((listed as ListObjectsV2Command).input).toMatchObject({
      Bucket: 'justcampus-transcription',
      Prefix: 'transcription/',
      StartAfter: 'a',
      MaxKeys: 2
    })
  })

  it('finds the component and job of a job object, and nothing for other keys', () => {
    expect(jobOfKey(objectKeys.sample('c', 'j', 'SPEAKER_00-1'))).toEqual({
      componentId: 'c',
      jobId: 'j'
    })
    expect(jobOfKey('transcription/c/jobs/j/')).toBeNull()
    expect(jobOfKey('transcription/c/connection-tests/x.txt')).toBeNull()
    expect(jobOfKey('other/c/jobs/j/source')).toBeNull()
  })
})

describe('objectKeys', () => {
  it('keeps every file of a job below its prefix', () => {
    const prefix = objectKeys.jobPrefix('c', 'j')
    expect(prefix).toBe('transcription/c/jobs/j/')
    for (const key of [
      objectKeys.source('c', 'j'),
      objectKeys.normalized('c', 'j'),
      objectKeys.chunk('c', 'j', 7),
      objectKeys.sample('c', 'j', 'SPEAKER_00/1')
    ]) {
      expect(key.startsWith(prefix)).toBe(true)
    }
    expect(objectKeys.chunk('c', 'j', 7)).toBe('transcription/c/jobs/j/chunks/007.wav')
    expect(objectKeys.sample('c', 'j', 'SPEAKER_00/1')).toBe(
      'transcription/c/jobs/j/samples/SPEAKER_00%2F1.wav'
    )
  })
})

describe('storageSettingsFromEnv', () => {
  it('reads the bucket, the endpoint and path-style addressing', () => {
    expect(storageSettingsFromEnv()).toEqual({
      endpoint: 'http://127.0.0.1:1',
      region: 'us-east-1',
      bucket: 'test-transcription',
      accessKeyId: 'test',
      secretAccessKey: 'test',
      forcePathStyle: true
    })
  })
})
