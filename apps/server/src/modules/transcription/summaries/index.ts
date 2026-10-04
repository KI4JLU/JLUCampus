import { Hono } from 'hono'

import type { AppEnvironment } from '../../types.js'
import { notImplemented } from '../stub.js'

/** Summaries by template, cached per revision, and AI section previews (`TRANSCRIPTION_API.summaries`). */
export const summariesRouter = new Hono<AppEnvironment>()

summariesRouter.post('/summaries', notImplemented)
summariesRouter.post('/summaries/preview', notImplemented)
