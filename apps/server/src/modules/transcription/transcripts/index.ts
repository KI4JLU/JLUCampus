import {
  transcriptionTranscriptCreateSchema,
  transcriptionTranscriptListSchema,
  transcriptionTranscriptPatchSchema
} from '@justcampus/shared'
import { Hono, type Context } from 'hono'
import { z } from 'zod'

import { ApiError, parseBody } from '../../../api.js'
import { getModuleRuntime } from '../../context.js'
import type { AppEnvironment } from '../../types.js'
import { upstream } from '../http.js'
import { requireChatTarget } from '../summaries/chat.js'
import { generateMetadataAfterSave, generateSubtitle } from './metadata.js'
import { buildNewTranscript } from './save.js'
import {
  deleteTranscripts,
  findTranscript,
  listTranscripts,
  publicTranscript,
  publicTranscriptSummary,
  retentionExpiry,
  saveTranscript,
  setGeneratedSubtitle,
  updateTranscript,
  type TranscriptChanges
} from './store.js'
import { plainText } from './text.js'

/**
 * Saved transcripts (`TRANSCRIPTION_API.transcripts` and below): saving a group's result once,
 * the history, the detail, revision-checked changes, deletion and the AI subtitle.
 */
export const transcriptsRouter = new Hono<AppEnvironment>()

type RouteContext = Context<AppEnvironment>

function owner(context: RouteContext): {
  componentId: string
  userId: string
  retentionHours: number | null
} {
  const { componentId, config } = getModuleRuntime(context, 'transcription')
  return {
    componentId,
    userId: context.get('session').user.id,
    retentionHours: config.transcriptRetentionHours
  }
}

/** The `:id` of the path; anything but a UUID names no transcript. */
function transcriptId(context: RouteContext): string {
  const id = z.uuid().safeParse(context.req.param('id'))
  if (!id.success) throw new ApiError(404, 'not_found', 'Transcript not found')
  return id.data
}

transcriptsRouter.get('/transcripts', async (context) => {
  const { componentId, userId, retentionHours } = owner(context)
  const rows = await listTranscripts(componentId, userId)
  return context.json(
    transcriptionTranscriptListSchema.parse({
      transcripts: rows.map((row) => publicTranscriptSummary(row, retentionHours))
    })
  )
})

/**
 * Saves one group's merged result once (T-13, T-14): `201` with the transcript, or `200` with the
 * one saved before under the same idempotency key. The chat model then writes a subtitle (and a
 * title for a made-up one) in the background.
 */
transcriptsRouter.post('/transcripts', async (context) => {
  const input = await parseBody(context, transcriptionTranscriptCreateSchema)
  const runtime = getModuleRuntime(context, 'transcription')
  const { componentId, userId, retentionHours } = owner(context)
  const userLocale = context.get('session').user.language ?? null
  const { row, created } = await saveTranscript(
    componentId,
    userId,
    input.idempotencyKey,
    input.jobIds,
    (jobs) =>
      buildNewTranscript(input, jobs, {
        config: runtime.config,
        userLocale,
        expiresAt: retentionExpiry(new Date(), retentionHours)
      })
  )
  if (created) void generateMetadataAfterSave(runtime, row)
  return context.json(publicTranscript(row, retentionHours), created ? 201 : 200)
})

transcriptsRouter.get('/transcripts/:id', async (context) => {
  const { componentId, userId, retentionHours } = owner(context)
  const row = await findTranscript(componentId, userId, transcriptId(context))
  if (!row) throw new ApiError(404, 'not_found', 'Transcript not found')
  return context.json(publicTranscript(row, retentionHours))
})

/**
 * Title, subtitle, segments and colours change independently (T-23, T-35), each only from the
 * revision the client started at, else `409 conflict`. An empty subtitle removes it; a typed one
 * counts as manual and wins over the generated one. Choosing a summary template alone is no
 * change: it keeps the revision, so it neither conflicts nor makes stored summaries stale.
 */
transcriptsRouter.patch('/transcripts/:id', async (context) => {
  const id = transcriptId(context)
  const patch = await parseBody(context, transcriptionTranscriptPatchSchema)
  const { componentId, userId, retentionHours } = owner(context)
  const changes: TranscriptChanges = {}
  if (patch.title !== undefined) changes.title = patch.title
  if (patch.subtitle !== undefined) {
    changes.subtitle = patch.subtitle || null
    changes.subtitleSource = patch.subtitle ? 'manual' : null
  }
  if (patch.segments !== undefined) {
    changes.segments = patch.segments
    changes.text = plainText(patch.segments)
  }
  if (patch.speakerColors !== undefined) changes.speakerColors = patch.speakerColors
  if (patch.summaryTemplateId !== undefined) changes.summaryTemplateId = patch.summaryTemplateId
  const bump = Object.keys(changes).some((key) => key !== 'summaryTemplateId')

  const row = await updateTranscript(
    componentId,
    userId,
    id,
    bump ? patch.baseRevision : null,
    changes,
    { bump, retentionHours }
  )
  if (row) return context.json(publicTranscript(row, retentionHours))
  if (!(await findTranscript(componentId, userId, id))) {
    throw new ApiError(404, 'not_found', 'Transcript not found')
  }
  throw new ApiError(409, 'conflict', 'The transcript was changed meanwhile')
})

/** Deletes the transcript; a second delete answers `404`, as the record is gone (T-40). */
transcriptsRouter.delete('/transcripts/:id', async (context) => {
  const { componentId, userId } = owner(context)
  const deleted = await deleteTranscripts(componentId, userId, [transcriptId(context)])
  if (deleted === 0) throw new ApiError(404, 'not_found', 'Transcript not found')
  return context.body(null, 204)
})

/** The chat model writes a new subtitle on request; it replaces any, manual ones included. */
transcriptsRouter.post('/transcripts/:id/subtitle', async (context) => {
  const id = transcriptId(context)
  const runtime = getModuleRuntime(context, 'transcription')
  const { componentId, userId, retentionHours } = owner(context)
  const row = await findTranscript(componentId, userId, id)
  if (!row) throw new ApiError(404, 'not_found', 'Transcript not found')
  const target = requireChatTarget(runtime, 'correction')
  const subtitle = await upstream('The chat model did not write a subtitle', () =>
    generateSubtitle(target, row.segments, context.req.raw.signal)
  )
  if (!subtitle) throw new ApiError(502, 'module_unavailable', 'The chat model wrote no subtitle')
  const updated = await setGeneratedSubtitle(componentId, userId, id, subtitle)
  if (!updated) throw new ApiError(404, 'not_found', 'Transcript not found')
  return context.json(publicTranscript(updated, retentionHours))
})
