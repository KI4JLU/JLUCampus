import { Hono } from 'hono'

import type { AppEnvironment } from '../../types.js'
import { notImplemented } from '../stub.js'

/** Summary templates: the five built-ins and the user's own (`TRANSCRIPTION_API.templates`). */
export const templatesRouter = new Hono<AppEnvironment>()

templatesRouter.get('/templates', notImplemented)
templatesRouter.post('/templates', notImplemented)
templatesRouter.delete('/templates/:id', notImplemented)
