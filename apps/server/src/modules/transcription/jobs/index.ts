import { Hono } from 'hono'

import type { AppEnvironment } from '../../types.js'
import { notImplemented } from '../stub.js'

/**
 * Batch jobs, one per uploaded file (`TRANSCRIPTION_API.jobs` and below): the upload session with
 * its signed `PUT`, the speaker analysis, dispatch, status, the user's active jobs, signed audio
 * and sample URLs, and cancelling plus deleting a job with its audio.
 */
export const jobsRouter = new Hono<AppEnvironment>()

jobsRouter.get('/jobs', notImplemented)
jobsRouter.post('/jobs', notImplemented)
jobsRouter.get('/jobs/:id', notImplemented)
jobsRouter.delete('/jobs/:id', notImplemented)
jobsRouter.post('/jobs/:id/analyze', notImplemented)
jobsRouter.post('/jobs/:id/dispatch', notImplemented)
jobsRouter.get('/jobs/:id/audio', notImplemented)
jobsRouter.get('/jobs/:id/samples/:sampleId', notImplemented)
