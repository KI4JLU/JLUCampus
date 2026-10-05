import {
  transcriptionTemplateIdSchema,
  transcriptionTemplateInputSchema,
  transcriptionTemplateListSchema
} from '@justcampus/shared'
import { Hono } from 'hono'

import { ApiError, parseBody } from '../../../api.js'
import { getModuleRuntime } from '../../context.js'
import type { AppEnvironment } from '../../types.js'
import {
  builtInTemplate,
  deleteTemplate,
  findTemplate,
  insertTemplate,
  listTemplates,
  updateTemplate
} from './store.js'

/** Summary templates: the five built-ins and the user's own (`TRANSCRIPTION_API.templates`). */
export const templatesRouter = new Hono<AppEnvironment>()

templatesRouter.get('/templates', async (context) => {
  const { componentId } = getModuleRuntime(context, 'transcription')
  const userId = context.get('session').user.id
  const templates = await listTemplates(componentId, userId)
  return context.json(transcriptionTemplateListSchema.parse({ templates }))
})

/**
 * Creates a template (`id` null) or changes one of the user's own, raising its version. Names may
 * repeat (T-51). Built-ins and admin-wide templates are read-only (`403`); users copy them instead.
 */
templatesRouter.post('/templates', async (context) => {
  const input = await parseBody(context, transcriptionTemplateInputSchema)
  const { componentId } = getModuleRuntime(context, 'transcription')
  const userId = context.get('session').user.id
  const values = { name: input.name, description: input.description, structure: input.structure }
  if (input.id === null) {
    return context.json(await insertTemplate(componentId, userId, values))
  }
  const found = await findTemplate(componentId, userId, input.id)
  if (!found) throw new ApiError(404, 'not_found', 'Template not found')
  if (!found.own) throw new ApiError(403, 'forbidden', 'Built-in templates cannot be changed')
  const updated = await updateTemplate(componentId, userId, input.id, values)
  if (!updated) throw new ApiError(404, 'not_found', 'Template not found')
  return context.json(updated)
})

templatesRouter.delete('/templates/:id', async (context) => {
  const parsed = transcriptionTemplateIdSchema.safeParse(context.req.param('id'))
  if (!parsed.success) throw new ApiError(404, 'not_found', 'Template not found')
  const id = parsed.data
  const { componentId } = getModuleRuntime(context, 'transcription')
  const userId = context.get('session').user.id
  if (builtInTemplate(id)) {
    throw new ApiError(403, 'forbidden', 'Built-in templates cannot be deleted')
  }
  const found = await findTemplate(componentId, userId, id)
  if (!found) throw new ApiError(404, 'not_found', 'Template not found')
  if (!found.own) throw new ApiError(403, 'forbidden', 'Built-in templates cannot be deleted')
  if (!(await deleteTemplate(componentId, userId, id))) {
    throw new ApiError(404, 'not_found', 'Template not found')
  }
  return context.body(null, 204)
})
