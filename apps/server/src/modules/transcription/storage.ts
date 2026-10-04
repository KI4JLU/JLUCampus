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
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import {
  TRANSCRIPTION_MEDIA_URL_TTL_SECONDS,
  TRANSCRIPTION_UPLOAD_URL_TTL_SECONDS,
  type TranscriptionMediaUrl,
  type TranscriptionUploadTarget
} from '@justcampus/shared'
import { createReadStream, createWriteStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { env } from '../../env.js'

/** Where the module keeps audio: an S3-compatible bucket (MinIO in docker compose). */
export interface StorageSettings {
  /** The endpoint the server talks to, e.g. `http://minio:9000` inside compose. */
  endpoint: string
  /** The endpoint signed URLs point at, which browsers must reach, e.g. `https://storage.example`. */
  publicEndpoint: string
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
    publicEndpoint: env.TRANSCRIPTION_S3_PUBLIC_ENDPOINT ?? endpoint,
    region: env.TRANSCRIPTION_S3_REGION,
    bucket,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: env.TRANSCRIPTION_S3_FORCE_PATH_STYLE
  }
}

/** An object's size and type, as storage reports them. */
export interface StoredObject {
  size: number
  contentType: string | null
}

function client(settings: StorageSettings, endpoint: string): S3Client {
  return new S3Client({
    endpoint,
    region: settings.region,
    forcePathStyle: settings.forcePathStyle,
    credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
    // Newer SDKs add CRC32 checksums to every upload; a browser's signed PUT cannot send one,
    // and MinIO versions differ in what they accept. Only where an operation requires it.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED'
  })
}

function expiry(seconds: number, now: Date): string {
  return new Date(now.getTime() + seconds * 1000).toISOString()
}

/** A filename as an inline `Content-Disposition`, ASCII fallback plus UTF-8. */
function inlineDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, '_')
  return `inline; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

/**
 * The module's object storage. The server reads and writes through `endpoint`; URLs for browsers
 * are signed for `publicEndpoint`, so both may differ (compose network vs. public host). Signed
 * URLs are bearer tokens: hand them out fresh from authenticated routes and never store them.
 */
export class TranscriptionStorage {
  readonly bucket: string
  private readonly internal: S3Client
  private readonly signer: S3Client

  constructor(readonly settings: StorageSettings) {
    this.bucket = settings.bucket
    this.internal = client(settings, settings.endpoint)
    this.signer =
      settings.publicEndpoint === settings.endpoint
        ? this.internal
        : client(settings, settings.publicEndpoint)
  }

  /**
   * A signed `PUT` for exactly `contentLength` bytes of `contentType`. The browser must send the
   * returned headers; it cannot change the size, since `Content-Length` is signed.
   */
  async presignUpload(
    key: string,
    options: { contentType: string; contentLength: number; expiresIn?: number; now?: Date }
  ): Promise<TranscriptionUploadTarget> {
    const expiresIn = options.expiresIn ?? TRANSCRIPTION_UPLOAD_URL_TTL_SECONDS
    const url = await getSignedUrl(
      this.signer,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: options.contentType,
        ContentLength: options.contentLength
      }),
      { expiresIn, signableHeaders: new Set(['content-type', 'content-length']) }
    )
    return {
      url,
      method: 'PUT',
      headers: { 'Content-Type': options.contentType },
      expiresAt: expiry(expiresIn, options.now ?? new Date())
    }
  }

  /** A signed `GET` for playback; `filename` names the file should the browser save it. */
  async presignDownload(
    key: string,
    options: { expiresIn?: number; contentType?: string; filename?: string; now?: Date } = {}
  ): Promise<TranscriptionMediaUrl> {
    const expiresIn = options.expiresIn ?? TRANSCRIPTION_MEDIA_URL_TTL_SECONDS
    const url = await getSignedUrl(
      this.signer,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentType: options.contentType,
        ResponseContentDisposition: options.filename
          ? inlineDisposition(options.filename)
          : undefined
      }),
      { expiresIn }
    )
    return { url, expiresAt: expiry(expiresIn, options.now ?? new Date()) }
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

  /** Deletes every object under `prefix`, e.g. all of one job's files. Returns how many. */
  async deletePrefix(prefix: string): Promise<number> {
    if (!prefix.endsWith('/')) throw new Error('A prefix to delete must end with "/"')
    let deleted = 0
    let token: string | undefined
    do {
      const page = await this.internal.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token })
      )
      const keys = (page.Contents ?? []).flatMap((object) => (object.Key ? [object.Key] : []))
      if (keys.length > 0) {
        await this.internal.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true }
          })
        )
        deleted += keys.length
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined
    } while (token)
    return deleted
  }

  /** Throws unless the bucket exists and the credentials may use it (admin connection test). */
  async ping(signal?: AbortSignal): Promise<void> {
    await this.internal.send(new HeadBucketCommand({ Bucket: this.bucket }), {
      abortSignal: signal
    })
  }
}

let shared: TranscriptionStorage | null | undefined

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
 * `…/samples/<sample>.wav`.
 */
export const objectKeys = {
  jobPrefix: (componentId: string, jobId: string): string =>
    `transcription/${componentId}/jobs/${jobId}/`,
  source: (componentId: string, jobId: string): string =>
    `${objectKeys.jobPrefix(componentId, jobId)}source`,
  normalized: (componentId: string, jobId: string): string =>
    `${objectKeys.jobPrefix(componentId, jobId)}normalized.wav`,
  chunk: (componentId: string, jobId: string, index: number): string =>
    `${objectKeys.jobPrefix(componentId, jobId)}chunks/${String(index).padStart(3, '0')}.wav`,
  sample: (componentId: string, jobId: string, sampleId: string): string =>
    `${objectKeys.jobPrefix(componentId, jobId)}samples/${encodeURIComponent(sampleId)}.wav`
}
