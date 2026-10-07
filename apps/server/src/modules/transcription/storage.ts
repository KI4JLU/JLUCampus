import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NotFound,
  PutObjectCommand,
  S3Client,
  S3ServiceException
} from '@aws-sdk/client-s3'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { env } from '../../env.js'

/** Where the module keeps audio: an S3-compatible bucket (MinIO in docker compose). */
export interface StorageSettings {
  /** The endpoint the server talks to, e.g. `http://minio:9000` inside compose. */
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  /** `bucket` in the path rather than the host name, as MinIO needs. */
  forcePathStyle: boolean
}

/** The storage settings from the environment, or `null` while any required one is missing. */
export function storageSettingsFromEnv(): StorageSettings | null {
  const endpoint = env.TRANSCRIPTION_S3_ENDPOINT
  const bucket = env.TRANSCRIPTION_S3_BUCKET
  const accessKeyId = env.TRANSCRIPTION_S3_ACCESS_KEY
  const secretAccessKey = env.TRANSCRIPTION_S3_SECRET_KEY
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null
  return {
    endpoint,
    region: env.TRANSCRIPTION_S3_REGION,
    bucket,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: env.TRANSCRIPTION_S3_FORCE_PATH_STYLE
  }
}

/** One page of a listing (`TranscriptionStorage.listObjects`). */
export interface ObjectPage {
  objects: Array<{ key: string; lastModified: Date | null }>
  truncated: boolean
}

/** An object's size and type, as storage reports them. */
export interface StoredObject {
  size: number
  contentType: string | null
}

/** The bytes of an object, or of the range asked for (`TranscriptionStorage.read`). */
export interface ObjectRead {
  body: Readable
  /** Bytes in `body`. */
  length: number
  contentType: string | null
  /** `bytes <first>-<last>/<size>` when storage answered a range, else `null`. */
  range: string | null
}

/**
 * Adds `Content-MD5` to `DeleteObjects`. S3 requires a checksum on it; newer SDKs send CRC32 only,
 * and older MinIO releases (the HRZ bucket store) refuse that with `MissingContentMD5`.
 */
function withContentMd5(s3: S3Client): S3Client {
  s3.middlewareStack.add(
    (next, context) => async (args) => {
      const request = args.request as { headers?: Record<string, string>; body?: unknown }
      if (
        context.commandName === 'DeleteObjectsCommand' &&
        request.headers &&
        (typeof request.body === 'string' || request.body instanceof Uint8Array)
      ) {
        request.headers['content-md5'] = createHash('md5').update(request.body).digest('base64')
      }
      return next(args)
    },
    { step: 'build', name: 'deleteObjectsContentMd5' }
  )
  return s3
}

function client(settings: StorageSettings): S3Client {
  return withContentMd5(
    new S3Client({
      endpoint: settings.endpoint,
      region: settings.region,
      forcePathStyle: settings.forcePathStyle,
      credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
      // Newer SDKs add CRC32 checksums to every upload, which a streamed body of known length
      // cannot carry up front, and MinIO versions differ in what they accept. Only where required.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED'
    })
  )
}

/**
 * The module's object storage. Only the server talks to it: browsers upload and play through the
 * job routes, which stream the bytes (`jobsRouter`), so the storage needs no public address.
 */
export class TranscriptionStorage {
  readonly bucket: string
  private readonly internal: S3Client

  constructor(readonly settings: StorageSettings) {
    this.bucket = settings.bucket
    this.internal = client(settings)
  }

  /** Size and type of an object, or `null` when it does not exist. */
  async head(key: string, signal?: AbortSignal): Promise<StoredObject | null> {
    try {
      const head = await this.internal.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
        { abortSignal: signal }
      )
      return { size: head.ContentLength ?? 0, contentType: head.ContentType ?? null }
    } catch (error) {
      if (error instanceof NotFound) return null
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) return null
      throw error
    }
  }

  /** Stores a buffer, or a stream of known length. */
  async put(
    key: string,
    body: Uint8Array | Readable,
    options: { contentType: string; contentLength?: number; signal?: AbortSignal }
  ): Promise<void> {
    await this.internal.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: options.contentType,
        ContentLength: options.contentLength
      }),
      { abortSignal: options.signal }
    )
  }

  /** The object's bytes as a stream; it must be consumed or destroyed. */
  async get(key: string, signal?: AbortSignal): Promise<Readable> {
    const object = await this.internal.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { abortSignal: signal }
    )
    if (!(object.Body instanceof Readable)) throw new Error(`Object ${key} has no body`)
    return object.Body
  }

  /**
   * The object's bytes, or those of `range` (an HTTP `Range` value, as a browser seeking in audio
   * sends it). The body must be consumed or destroyed.
   */
  async read(
    key: string,
    options: { range?: string; signal?: AbortSignal } = {}
  ): Promise<ObjectRead> {
    const object = await this.internal.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: options.range }),
      { abortSignal: options.signal }
    )
    if (!(object.Body instanceof Readable)) throw new Error(`Object ${key} has no body`)
    return {
      body: object.Body,
      length: object.ContentLength ?? 0,
      contentType: object.ContentType ?? null,
      range: object.ContentRange ?? null
    }
  }

  /** Copies an object into a local file, e.g. for ffmpeg, without holding it in memory. */
  async downloadToFile(key: string, path: string, signal?: AbortSignal): Promise<void> {
    await pipeline(await this.get(key, signal), createWriteStream(path), { signal })
  }

  /** Stores a local file, streamed. */
  async uploadFile(
    key: string,
    path: string,
    contentType: string,
    signal?: AbortSignal
  ): Promise<void> {
    const { size } = await stat(path)
    await this.put(key, createReadStream(path), { contentType, contentLength: size, signal })
  }

  async delete(key: string): Promise<void> {
    await this.internal.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
  }

  /**
   * One page of the objects under `prefix`, in key order, from after `startAfter`. A page holds at
   * most `maxKeys` (S3 caps it at 1000); `truncated` says whether more follow.
   */
  async listObjects(
    prefix: string,
    options: { startAfter?: string; maxKeys?: number } = {}
  ): Promise<ObjectPage> {
    const page = await this.internal.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        StartAfter: options.startAfter,
        MaxKeys: options.maxKeys
      })
    )
    return {
      objects: (page.Contents ?? []).flatMap((object) =>
        object.Key ? [{ key: object.Key, lastModified: object.LastModified ?? null }] : []
      ),
      truncated: page.IsTruncated === true
    }
  }

  /**
   * Deletes the objects, at most 1000 (one S3 request). Returns the keys the storage refused to
   * delete (S3 answers `200` and lists them under `Errors`).
   */
  async deleteObjects(keys: readonly string[]): Promise<PartialDeleteError['failures']> {
    if (keys.length === 0) return []
    const result = await this.internal.send(
      new DeleteObjectsCommand({
        Bucket: this.bucket,
        Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true }
      })
    )
    return (result.Errors ?? []).map((error) => ({
      key: error.Key ?? null,
      code: error.Code ?? null
    }))
  }

  /**
   * Deletes every object under `prefix`, e.g. all of one job's files. Returns how many. Objects
   * the storage refused to delete make it throw `PartialDeleteError` once every page was tried, so
   * callers keep the job for another attempt.
   */
  async deletePrefix(prefix: string): Promise<number> {
    if (!prefix.endsWith('/')) throw new Error('A prefix to delete must end with "/"')
    let deleted = 0
    const failed: PartialDeleteError['failures'] = []
    let token: string | undefined
    do {
      const page = await this.internal.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token })
      )
      const keys = (page.Contents ?? []).flatMap((object) => (object.Key ? [object.Key] : []))
      const errors = await this.deleteObjects(keys)
      failed.push(...errors)
      deleted += keys.length - errors.length
      token = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (token)
    if (failed.length > 0) throw new PartialDeleteError(prefix, failed)
    return deleted
  }

  /** Throws unless the bucket exists and the credentials may use it (admin connection test). */
  async ping(signal?: AbortSignal): Promise<void> {
    await this.internal.send(new HeadBucketCommand({ Bucket: this.bucket }), {
      abortSignal: signal
    })
  }
}

/** Storage deleted only part of a prefix; the rest stays for the next attempt. */
export class PartialDeleteError extends Error {
  constructor(
    readonly prefix: string,
    readonly failures: { key: string | null; code: string | null }[]
  ) {
    const codes = [...new Set(failures.map((failure) => failure.code ?? 'unknown'))].join(', ')
    super(`Storage kept ${failures.length} object(s) under ${prefix} (${codes})`)
    this.name = 'PartialDeleteError'
  }
}

let shared: TranscriptionStorage | null | undefined

/** Whether a storage error says the object does not exist. */
export function missingObject(error: unknown): boolean {
  const named = error as { name?: string; $metadata?: { httpStatusCode?: number } } | null
  return named?.name === 'NoSuchKey' || named?.$metadata?.httpStatusCode === 404
}

/** The storage from the environment, created once; `null` while it is not configured. */
export function transcriptionStorage(): TranscriptionStorage | null {
  if (shared === undefined) {
    const settings = storageSettingsFromEnv()
    shared = settings ? new TranscriptionStorage(settings) : null
  }
  return shared
}

/**
 * Object keys, all below one prefix per job, so deleting a job removes everything it left:
 * `transcription/<component>/jobs/<job>/source`, `…/normalized.wav`, `…/chunks/<n>.wav`,
 * `…/samples/<sample>.wav`, `…/peaks.json`.
 */
export const objectKeys = {
  /** Everything the module stores, of every component. */
  root: 'transcription/',
  jobPrefix: (componentId: string, jobId: string): string =>
    `transcription/${componentId}/jobs/${jobId}/`,
  source: (componentId: string, jobId: string): string =>
    `${objectKeys.jobPrefix(componentId, jobId)}source`,
  normalized: (componentId: string, jobId: string): string =>
    `${objectKeys.jobPrefix(componentId, jobId)}normalized.wav`,
  /** The waveform the analysis computed (`transcriptionJobPeaksSchema`). */
  peaks: (componentId: string, jobId: string): string =>
    `${objectKeys.jobPrefix(componentId, jobId)}peaks.json`,
  chunk: (componentId: string, jobId: string, index: number): string =>
    `${objectKeys.jobPrefix(componentId, jobId)}chunks/${String(index).padStart(3, '0')}.wav`,
  sample: (componentId: string, jobId: string, sampleId: string): string =>
    `${objectKeys.jobPrefix(componentId, jobId)}samples/${encodeURIComponent(sampleId)}.wav`
}

const JOB_KEY = /^transcription\/([^/]+)\/jobs\/([^/]+)\/./

/** The component and job an object key belongs to, or `null` for keys outside `jobPrefix`. */
export function jobOfKey(key: string): { componentId: string; jobId: string } | null {
  const match = JOB_KEY.exec(key)
  return match ? { componentId: match[1]!, jobId: match[2]! } : null
}
