import { Hono } from 'hono'

import type { AppEnvironment } from '../../types.js'
import { notImplemented } from '../stub.js'

/** AI speaker optimisation (`TRANSCRIPTION_API.speakerOptimization`). */
export const optimizeRouter = new Hono<AppEnvironment>()

optimizeRouter.post('/speaker-optimization', notImplemented)
