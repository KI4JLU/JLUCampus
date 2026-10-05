import type { z } from 'zod'
import type { transcriptionTranscriptCreateSchema } from '@justcampus/shared'

import { ApiError } from '../../../api.js'
import { asrModel, type TranscriptionRuntime } from '../config.js'
import type { GroupJob, NewTranscript } from './store.js'
import { plainText } from './text.js'

type TranscriptCreate = z.output<typeof transcriptionTranscriptCreateSchema>

/**
 * Checks a group's jobs and makes the transcript's columns (T-13, T-14). Every job must be the
 * user's (else `404`), completed and not yet saved (else `409`), at most the admin's files per
 * transcript; source files may only name the group's jobs. Model and provider come from the jobs' results, else from the settings, as kiChat's
 * backend supplies them.
 */
export function buildNewTranscript(
  input: TranscriptCreate,
  jobs: readonly GroupJob[],
  context: {
    config: TranscriptionRuntime['config']
    userLocale: string | null
    expiresAt: Date | null
  }
): NewTranscript {
  // The admin's optional limit per transcript (T-04); the browser stops before uploading more.
  const limit = context.config.maxFilesPerGroup
  if (limit !== null && input.jobIds.length > limit) {
    throw new ApiError(400, 'validation', 'Request validation failed', [
      { path: ['jobIds'], message: 'The transcript has more files than allowed' }
    ])
  }
  if (new Set(input.jobIds).size !== input.jobIds.length) {
    throw new ApiError(400, 'validation', 'Request validation failed', [
      { path: ['jobIds'], message: 'A job is named twice' }
    ])
  }
  const ordered = input.jobIds.map((id) => {
    const job = jobs.find((candidate) => candidate.id === id)
    if (!job) throw new ApiError(404, 'not_found', 'Job not found')
    return job
  })
  if (ordered.some((job) => job.transcriptId !== null)) {
    throw new ApiError(409, 'conflict', 'A job of the group is saved already')
  }
  if (ordered.some((job) => job.status !== 'completed')) {
    throw new ApiError(409, 'conflict', 'Not every job of the group is completed')
  }
  input.sourceFiles.forEach((file, index) => {
    if (file.jobId !== null && !input.jobIds.includes(file.jobId)) {
      throw new ApiError(400, 'validation', 'Request validation failed', [
        { path: ['sourceFiles', index, 'jobId'], message: 'Not a job of the group' }
      ])
    }
  })

  const result = ordered.find((job) => job.result)?.result ?? null
  return {
    title: input.title,
    language: input.language,
    duration: input.duration,
    model: result?.model ?? asrModel(context.config)?.id ?? null,
    provider: result?.provider ?? context.config.providerName,
    originalFilename: ordered[0]?.filename ?? null,
    fileSize: ordered.reduce((sum, job) => sum + job.size, 0),
    segments: input.segments,
    words: input.words,
    text: plainText(input.segments),
    sourceFiles: input.sourceFiles,
    speakerColors: input.speakerColors,
    userLocale: context.userLocale,
    expiresAt: context.expiresAt
  }
}
