import {
  transcriptionSpeakerOptimizationRequestSchema,
  transcriptionSpeakerOptimizationSchema
} from '@justcampus/shared'
import { Hono } from 'hono'

import { ApiError, parseBody } from '../../../api.js'
import { getModuleRuntime } from '../../context.js'
import type { AppEnvironment } from '../../types.js'
import { upstream } from '../http.js'
import { requireChatTarget } from '../summaries/chat.js'
import { findTranscript } from '../transcripts/store.js'
import { optimizeSpeakers } from './speakers.js'

/**
 * AI speaker optimisation (`TRANSCRIPTION_API.speakerOptimization`, T-36). The answer replaces the
 * client's segments, which it saves through the usual revision-checked `PATCH` as an undoable
 * change; this route stores nothing. A named transcript must be the user's.
 */
export const optimizeRouter = new Hono<AppEnvironment>()

optimizeRouter.post('/speaker-optimization', async (context) => {
  const input = await parseBody(context, transcriptionSpeakerOptimizationRequestSchema)
  const runtime = getModuleRuntime(context, 'transcription')
  if (input.transcriptId !== null) {
    const owned = await findTranscript(
      runtime.componentId,
      context.get('session').user.id,
      input.transcriptId
    )
    if (!owned) throw new ApiError(404, 'not_found', 'Transcript not found')
  }
  const target = requireChatTarget(runtime, 'correction', input.model)
  const segments = await upstream('The chat model did not optimise the speakers', () =>
    optimizeSpeakers(target, input.segments, context.req.raw.signal)
  )
  return context.json(transcriptionSpeakerOptimizationSchema.parse({ segments }))
})
