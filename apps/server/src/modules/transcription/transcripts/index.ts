import { Hono } from 'hono'

import type { AppEnvironment } from '../../types.js'
import { notImplemented } from '../stub.js'

/**
 * Saved transcripts (`TRANSCRIPTION_API.transcripts` and below): saving a group's result once,
 * the history, the detail, revision-checked changes, deletion and the AI subtitle.
 */
export const transcriptsRouter = new Hono<AppEnvironment>()

transcriptsRouter.get('/transcripts', notImplemented)
transcriptsRouter.post('/transcripts', notImplemented)
transcriptsRouter.get('/transcripts/:id', notImplemented)
transcriptsRouter.patch('/transcripts/:id', notImplemented)
transcriptsRouter.delete('/transcripts/:id', notImplemented)
transcriptsRouter.post('/transcripts/:id/subtitle', notImplemented)
