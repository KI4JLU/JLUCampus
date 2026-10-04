import { Hono } from 'hono'

import type { AppEnvironment } from '../../types.js'
import { notImplemented } from '../stub.js'

/**
 * The admin form's helpers (`TRANSCRIPTION_API.adminModels`, `TRANSCRIPTION_API.adminTest`): model
 * discovery and connection tests. They also work while the module is disabled.
 */
export const adminRouter = new Hono<AppEnvironment>()

adminRouter.post('/models', notImplemented)
adminRouter.post('/test', notImplemented)
