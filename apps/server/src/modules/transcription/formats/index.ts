import { transcriptionFormatInputSchema, transcriptionFormatListSchema } from '@justcampus/shared'
import { Hono } from 'hono'
import { z } from 'zod'

import { ApiError, parseBody } from '../../../api.js'
import { getModuleRuntime } from '../../context.js'
import type { AppEnvironment } from '../../types.js'
import { deleteFormat, listFormats, saveFormat } from './store.js'

/** The user's own transcript export formats (`TRANSCRIPTION_API.formats`). */
export const formatsRouter = new Hono<AppEnvironment>()

formatsRouter.get('/formats', async (context) => {
  const { componentId } = getModuleRuntime(context, 'transcription')
  const formats = await listFormats(componentId, context.get('session').user.id)
  return context.json(transcriptionFormatListSchema.parse({ formats }))
})

/**
 * Creates a format (`id` null) or changes one of the user's own. A name another of their formats
 * has, in any case, gets a number (`Name (1)`), as in kiChat; the answer carries the final name.
 */
formatsRouter.post('/formats', async (context) => {
  const { id, ...values } = await parseBody(context, transcriptionFormatInputSchema)
  const { componentId } = getModuleRuntime(context, 'transcription')
  const format = await saveFormat(componentId, context.get('session').user.id, id, values)
  if (!format) throw new ApiError(404, 'not_found', 'Format not found')
  return context.json(format)
})

formatsRouter.delete('/formats/:id', async (context) => {
  const id = z.uuid().safeParse(context.req.param('id'))
  const { componentId } = getModuleRuntime(context, 'transcription')
  if (!id.success || !(await deleteFormat(componentId, context.get('session').user.id, id.data))) {
    throw new ApiError(404, 'not_found', 'Format not found')
  }
  return context.body(null, 204)
})
