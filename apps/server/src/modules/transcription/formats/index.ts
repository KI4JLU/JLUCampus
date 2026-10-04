import { Hono } from 'hono'

import type { AppEnvironment } from '../../types.js'
import { notImplemented } from '../stub.js'

/** The user's own transcript export formats (`TRANSCRIPTION_API.formats`). */
export const formatsRouter = new Hono<AppEnvironment>()

formatsRouter.get('/formats', notImplemented)
formatsRouter.post('/formats', notImplemented)
formatsRouter.delete('/formats/:id', notImplemented)
