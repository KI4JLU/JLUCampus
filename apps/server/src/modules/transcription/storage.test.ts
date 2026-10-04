import { describe, expect, it } from 'vitest'

import { objectKeys, storageSettingsFromEnv, TranscriptionStorage } from './storage.js'

const storage = new TranscriptionStorage({
  endpoint: 'http://minio:9000',
  publicEndpoint: 'http://localhost:9100',
  region: 'us-east-1',
  bucket: 'justcampus-transcription',
  accessKeyId: 'access',
  secretAccessKey: 'secret',
  forcePathStyle: true
})
const now = new Date('2026-10-04T08:00:00.000Z')

describe('TranscriptionStorage', () => {
  it('signs uploads for the public endpoint, size and type included', async () => {
    const key = objectKeys.source('component', 'job')
    const target = await storage.presignUpload(key, {
      contentType: 'audio/wav',
      contentLength: 495_752,
      now
    })
    const url = new URL(target.url)
    expect(url.origin).toBe('http://localhost:9100')
    expect(url.pathname).toBe('/justcampus-transcription/transcription/component/jobs/job/source')
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600')
    expect(url.searchParams.get('X-Amz-SignedHeaders')?.split(';')).toEqual(
      expect.arrayContaining(['content-length', 'content-type', 'host'])
    )
    expect([...url.searchParams.keys()].some((name) => /checksum/i.test(name))).toBe(false)
    expect(target).toMatchObject({
      method: 'PUT',
      headers: { 'Content-Type': 'audio/wav' },
      expiresAt: '2026-10-04T09:00:00.000Z'
    })
  })

  it('signs playback for two hours by default', async () => {
    const media = await storage.presignDownload(objectKeys.normalized('c', 'j'), {
      filename: 'Interview Größe.wav',
      now
    })
    const url = new URL(media.url)
    expect(url.searchParams.get('X-Amz-Expires')).toBe('7200')
    expect(url.searchParams.get('response-content-disposition')).toContain(
      "filename*=UTF-8''Interview%20Gr%C3%B6%C3%9Fe.wav"
    )
    expect(media.expiresAt).toBe('2026-10-04T10:00:00.000Z')
  })

  it('refuses to delete a prefix that is not a folder', async () => {
    await expect(storage.deletePrefix('transcription/c/jobs/j')).rejects.toThrow('must end with')
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
  it('reads the bucket, both endpoints and path-style addressing', () => {
    expect(storageSettingsFromEnv()).toEqual({
      endpoint: 'http://127.0.0.1:1',
      publicEndpoint: 'http://storage.test',
      region: 'us-east-1',
      bucket: 'test-transcription',
      accessKeyId: 'test',
      secretAccessKey: 'test',
      forcePathStyle: true
    })
  })
})
