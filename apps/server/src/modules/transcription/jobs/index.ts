import { randomUUID } from 'node:crypto'

import {
  TRANSCRIPTION_PROCESSING_STATUSES,
  transcriptionAnalyzeSchema,
  transcriptionDispatchSchema,
  transcriptionJobCreatedSchema,
  transcriptionJobCreateSchema,
  transcriptionJobListSchema,
  transcriptionJobPeaksSchema,
  transcriptionMediaUrlSchema,
  type TranscriptionJobStatus
} from '@justcampus/shared'
import { Hono, type Context } from 'hono'
import { z } from 'zod'

import { ApiError, parseBody, validationIssues } from '../../../api.js'
import { getModuleRuntime } from '../../context.js'
import type { AppEnvironment } from '../../types.js'
import { capabilitiesOf, llmModel, type TranscriptionRuntime } from '../config.js'
import { upstream } from '../http.js'
import {
  missingObject,
  objectKeys,
  transcriptionStorage,
  type TranscriptionStorage
} from '../storage.js'
import { jobExpiry, publicJob, uploadSettled, type JobRow } from './rows.js'
import { jobActions, progressOf } from './state.js'
import {
  claimHeld,
  countActiveJobs,
  deleteJobRow,
  findJob,
  findJobForDeletion,
  insertJob,
  listJobs,
  markDeleted,
  transitionJob,
  unchangedSince
} from './store.js'
import { cleanFilename, dispatchIssues, uploadContentType } from './validate.js'
import { CLAIM_LEASE_MS, wakeJobWorker } from './worker.js'

/**
 * Batch jobs, one per uploaded file (`TRANSCRIPTION_API.jobs` and below): the upload session with
 * its signed `PUT`, the speaker analysis, dispatch, status, the user's active jobs, signed audio
 * and sample URLs, and cancelling plus deleting a job with its audio. Another user's job answers
 * `404 not_found` like a missing one.
 */
export const jobsRouter = new Hono<AppEnvironment>()

type JobContext = Context<AppEnvironment>

function runtimeOf(context: JobContext): TranscriptionRuntime {
  return getModuleRuntime(context, 'transcription')
}

function userOf(context: JobContext): string {
  return context.get('session').user.id
}

/** The object storage, or `502 module_unavailable` while it is not configured. */
function requireStorage(): TranscriptionStorage {
  const storage = transcriptionStorage()
  if (!storage) throw new ApiError(502, 'module_unavailable', 'Storage is not set up')
  return storage
}

/** Storage plus a speech endpoint and model, which uploads and transcriptions need. */
function requireBatch(runtime: TranscriptionRuntime): TranscriptionStorage {
  const storage = requireStorage()
  if (!capabilitiesOf(runtime.config, runtime.secrets, true).batch) {
    throw new ApiError(502, 'module_unavailable', 'Transcription is not set up')
  }
  return storage
}

function validation(path: Array<string | number>, message: string): never {
  throw new ApiError(400, 'validation', 'Request validation failed', [{ path, message }])
}

const notFound = (): ApiError => new ApiError(404, 'not_found', 'Job not found')

/** The user's job named in the path; `404` for malformed ids too. */
async function ownJob(context: JobContext): Promise<JobRow> {
  const id = context.req.param('id') ?? ''
  if (!z.uuid().safeParse(id).success) throw notFound()
  const job = await findJob(id, runtimeOf(context).componentId, userOf(context))
  if (!job) throw notFound()
  return job
}

/** A body that may be empty, as the analysis request usually is. */
async function optionalBody<T>(context: JobContext, schema: z.ZodType<T>): Promise<T> {
  const text = await context.req.text()
  let body: unknown = {}
  if (text.trim()) {
    try {
      body = JSON.parse(text)
    } catch {
      validation([], 'Expected a JSON request body')
    }
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    throw new ApiError(
      400,
      'validation',
      'Request validation failed',
      validationIssues(parsed.error)
    )
  }
  return parsed.data
}

function isProcessing(status: TranscriptionJobStatus): boolean {
  return (TRANSCRIPTION_PROCESSING_STATUSES as readonly string[]).includes(status)
}

jobsRouter.get('/jobs', async (context) => {
  const rows = await listJobs(runtimeOf(context).componentId, userOf(context))
  return context.json(
    transcriptionJobListSchema.parse({ jobs: rows.map((row) => publicJob(row, false)) })
  )
})

/** The upload session (T-03, T-04, T-10): checks the file, creates the job, signs one `PUT`. */
jobsRouter.post('/jobs', async (context) => {
  const runtime = runtimeOf(context)
  const { componentId, config } = runtime
  const userId = userOf(context)
  const storage = requireBatch(runtime)
  const input = await parseBody(context, transcriptionJobCreateSchema)
  const filename = cleanFilename(input.filename)
  if (!filename) validation(['filename'], 'Invalid filename')
  if (input.size > config.maxFileBytes) validation(['size'], 'The file is too large')
  if ((await countActiveJobs(componentId, userId)) >= config.maxActiveJobsPerUser) {
    throw new ApiError(429, 'rate_limited', 'Too many active transcription jobs')
  }
  // No count per group here: files move between groups in the browser after their upload, so the
  // group named now says nothing about the transcript they end up in. The browser stops at the
  // limit before uploading, and the save refuses a group above the admin's limit (T-04, T-07).

  const id = randomUUID()
  const contentType = uploadContentType(filename, input.mimeType)
  const objectKey = objectKeys.source(componentId, id)
  const upload = await upstream('The upload could not be prepared', () =>
    storage.presignUpload(objectKey, { contentType, contentLength: input.size })
  )
  const correction = llmModel(config, 'correction') !== null
  const row = await insertJob({
    id,
    componentId,
    userId,
    groupId: input.groupId,
    groupOrder: input.groupOrder,
    filename,
    mimeType: contentType,
    size: input.size,
    objectKey,
    status: 'uploading',
    settings: {
      language: input.language,
      speakerCount: input.speakerCount,
      llmCorrection: input.llmCorrection && correction
    },
    expiresAt: jobExpiry(config.unsavedJobRetentionHours)
  })
  return context.json(
    transcriptionJobCreatedSchema.parse({ job: publicJob(row, false), upload }),
    201
  )
})

/** Status, progress, voices and, once completed, the result (polled every two seconds). */
jobsRouter.get('/jobs/:id', async (context) => {
  return context.json(publicJob(await ownJob(context), true))
})

/**
 * Cancels the job and deletes everything it stored (T-08). Another user's job, an unknown id and
 * one already gone answer `404` like every other job route; the browser counts that as deleted.
 * If storage cannot delete (also only some objects), the answer is `502` and the job stays
 * hidden; the next DELETE or the sweep finishes the work. A job whose signed upload could still
 * arrive also stays hidden until the sweep's final cleanup (`uploadSettled`).
 */
jobsRouter.delete('/jobs/:id', async (context) => {
  const id = context.req.param('id')
  if (!z.uuid().safeParse(id).success) throw notFound()
  const { componentId } = runtimeOf(context)
  const job = await findJobForDeletion(id, componentId, userOf(context))
  if (!job) throw notFound()
  const marked = (await markDeleted(job.id)) ?? job
  const storage = transcriptionStorage()
  if (storage) {
    await upstream('The audio could not be deleted', () =>
      storage.deletePrefix(objectKeys.jobPrefix(componentId, job.id))
    )
  }
  // A worker still running stops at its next write, and a signed upload stays valid after this
  // deletion: its PUT may still store the audio again. Then the row stays, hidden, and the sweep
  // deletes what was stored meanwhile and the row once the worker let go and the upload settled.
  if (!claimHeld(marked, CLAIM_LEASE_MS) && uploadSettled(job.createdAt)) {
    await deleteJobRow(job.id)
  }
  return context.body(null, 204)
})

/**
 * The upload is done (T-10): checks the stored bytes and queues the speaker analysis. Again after
 * `analyzed` or `failed` it repeats the analysis (T-21); while one is queued or running it changes
 * nothing, so a reconnecting browser does not start a second.
 */
jobsRouter.post('/jobs/:id/analyze', async (context) => {
  const runtime = runtimeOf(context)
  const storage = requireStorage()
  const input = await optionalBody(context, transcriptionAnalyzeSchema)
  const job = await ownJob(context)
  const status = job.status as TranscriptionJobStatus
  const actions = jobActions(status, job.error ?? null)
  if (actions.analyzeRunning) return context.json(publicJob(job, true))
  if (!actions.analyze) {
    throw new ApiError(409, 'conflict', 'The job is being transcribed or done')
  }

  const stored = await upstream('The upload could not be checked', () =>
    storage.head(job.objectKey)
  )
  const now = new Date()
  const expiresAt = jobExpiry(runtime.config.unsavedJobRetentionHours, now)
  const sameState = unchangedSince(job.updatedAt)
  if (!stored || stored.size !== Number(job.size)) {
    if (!stored && status === 'uploading') {
      throw new ApiError(409, 'conflict', 'The upload has not arrived yet')
    }
    const failed = await transitionJob(
      job.id,
      [status],
      {
        status: 'failed',
        error: stored
          ? {
              code: 'upload_size_mismatch',
              message: `Die hochgeladene Datei hat ${stored.size} statt ${job.size} Bytes.`
            }
          : { code: 'upload_missing', message: 'Die hochgeladene Datei wurde nicht gefunden.' },
        progress: null,
        expiresAt,
        updatedAt: now
      },
      sameState
    )
    return context.json(publicJob(failed ?? (await ownJob(context)), true))
  }

  const queued = await transitionJob(
    job.id,
    [status],
    {
      status: 'analyzingQueued',
      uploadedAt: job.uploadedAt ?? now,
      duration: job.normalizedKey ? job.duration : (input.duration ?? job.duration),
      // The diariser hears the count chosen now, not the one at upload (T-09).
      settings: input.speakerCount
        ? { ...job.settings, speakerCount: input.speakerCount }
        : job.settings,
      error: null,
      result: null,
      progress: progressOf('queued'),
      attempts: 0,
      claimedAt: null,
      heartbeatAt: null,
      cancelRequestedAt: null,
      completedAt: null,
      expiresAt,
      updatedAt: now
    },
    sameState
  )
  if (!queued) {
    // Another request changed the job meanwhile; answer its state if that is an analysis.
    const current = await ownJob(context)
    if (jobActions(current.status as TranscriptionJobStatus, null).analyzeRunning) {
      return context.json(publicJob(current, true))
    }
    throw new ApiError(409, 'conflict', 'The job changed meanwhile')
  }
  wakeJobWorker()
  return context.json(publicJob(queued, true))
})

/**
 * Starts the transcription with the names, voice windows and settings (T-13, T-18 to T-20). A job
 * is dispatched once; only a transcription that failed may be dispatched again.
 */
jobsRouter.post('/jobs/:id/dispatch', async (context) => {
  const runtime = runtimeOf(context)
  requireBatch(runtime)
  const input = await parseBody(context, transcriptionDispatchSchema)
  const job = await ownJob(context)
  const status = job.status as TranscriptionJobStatus
  if (!jobActions(status, job.error ?? null).dispatch) {
    throw new ApiError(
      409,
      'conflict',
      isProcessing(status) || status === 'completed'
        ? 'The job was dispatched already'
        : 'The job is not analysed yet'
    )
  }
  const issues = dispatchIssues(input, job, {
    correctionAvailable: llmModel(runtime.config, 'correction') !== null
  })
  if (issues.length > 0) {
    throw new ApiError(400, 'validation', 'Request validation failed', issues)
  }

  const now = new Date()
  const dispatched = await transitionJob(
    job.id,
    [status],
    {
      status: 'preprocessing',
      settings: {
        language: input.language ?? job.settings.language,
        speakerCount: input.speakerCount,
        llmCorrection: input.llmCorrection
      },
      mapping: Object.fromEntries(
        Object.entries(input.mapping).map(([id, name]) => [id, name.trim()])
      ),
      snippets: input.snippets,
      colors: input.colors,
      error: null,
      result: null,
      progress: progressOf('queued'),
      attempts: 0,
      claimedAt: null,
      heartbeatAt: null,
      completedAt: null,
      expiresAt: jobExpiry(runtime.config.unsavedJobRetentionHours, now),
      updatedAt: now
    },
    unchangedSince(job.updatedAt)
  )
  if (!dispatched) throw new ApiError(409, 'conflict', 'The job was dispatched already')
  wakeJobWorker()
  return context.json(publicJob(dispatched, true))
})

/** A fresh signed URL of the uploaded audio (T-12, T-24); also for saved transcripts' jobs. */
jobsRouter.get('/jobs/:id/audio', async (context) => {
  const storage = requireStorage()
  const job = await ownJob(context)
  if (job.status === 'uploading')
    throw new ApiError(404, 'not_found', 'The audio is not uploaded yet')
  const media = await upstream('The audio link could not be signed', () =>
    storage.presignDownload(job.objectKey, { contentType: job.mimeType, filename: job.filename })
  )
  return context.json(transcriptionMediaUrlSchema.parse(media))
})

/**
 * The waveform the analysis computed (T-12, T-19), for files too large for the browser to decode;
 * `404` before the analysis or when it computed none.
 */
jobsRouter.get('/jobs/:id/peaks', async (context) => {
  const storage = requireStorage()
  const job = await ownJob(context)
  const body = await upstream('The waveform could not be read', async () => {
    try {
      const stream = await storage.get(objectKeys.peaks(job.componentId, job.id))
      const chunks: Buffer[] = []
      for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array))
      return Buffer.concat(chunks).toString('utf8')
    } catch (error) {
      if (missingObject(error)) return null
      throw error
    }
  })
  const peaks = body === null ? null : transcriptionJobPeaksSchema.safeParse(parseJson(body))
  if (!peaks?.success) throw new ApiError(404, 'not_found', 'No waveform')
  return context.json(peaks.data)
})

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** A fresh signed URL of one analysed voice sample (T-17, T-21). */
jobsRouter.get('/jobs/:id/samples/:sampleId', async (context) => {
  const storage = requireStorage()
  const job = await ownJob(context)
  const sampleId = context.req.param('sampleId')
  const sample = job.speakers
    .flatMap((speaker) => speaker.samples)
    .find((candidate) => candidate.id === sampleId)
  if (!sample) throw new ApiError(404, 'not_found', 'Sample not found')
  const media = await upstream('The sample link could not be signed', () =>
    storage.presignDownload(objectKeys.sample(job.componentId, job.id, sample.id), {
      contentType: 'audio/wav',
      filename: `${sample.id}.wav`
    })
  )
  return context.json(transcriptionMediaUrlSchema.parse(media))
})
