import {
  TRANSCRIPTION_EVENTS_HEARTBEAT_MS,
  TRANSCRIPTION_EVENTS_RETRY_MS,
  type TranscriptionEvent
} from '@justcampus/shared'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'

import { getModuleRuntime } from '../../context.js'
import type { AppEnvironment } from '../../types.js'
import { publicJob } from '../jobs/rows.js'
import { listJobs } from '../jobs/store.js'
import { transcriptionEventsHub } from './hub.js'

/** Recheck cookie authentication on reconnect, including sessions ended at Keycloak. */
export const TRANSCRIPTION_EVENTS_MAX_AGE_MS = 5 * 60_000
export const eventsRouter = new Hono<AppEnvironment>()

eventsRouter.get('/events', (context) => {
  const { componentId } = getModuleRuntime(context, 'transcription')
  const userId = context.get('session').user.id
  context.header('X-Accel-Buffering', 'no')
  const response = streamSSE(context, async (stream) => {
    let closed = false
    let buffering = true
    const buffered: TranscriptionEvent[] = []
    let writes = Promise.resolve()
    let finish!: () => void
    const done = new Promise<void>((resolve) => {
      finish = resolve
    })
    const close = (): void => {
      if (closed) return
      closed = true
      finish()
      // Cancel pending writes too, so a slow reader cannot extend the session lifetime.
      stream.abort()
    }
    const send = (event: TranscriptionEvent): void => {
      if (closed) return
      if (buffering) {
        buffered.push(event)
        return
      }
      writes = writes
        .then(async () => {
          if (!closed)
            await stream.writeSSE({ event: event.type, data: JSON.stringify(event.data) })
        })
        .catch(close)
    }
    const unsubscribe = transcriptionEventsHub.subscribe(componentId, userId, { send, close })
    stream.onAbort(close)
    context.req.raw.signal.addEventListener('abort', close, { once: true })
    const maxAge = setTimeout(close, TRANSCRIPTION_EVENTS_MAX_AGE_MS)
    const heartbeat = setInterval(() => {
      writes = writes
        .then(async () => {
          if (!closed) await stream.write(': heartbeat\n\n')
        })
        .catch(close)
    }, TRANSCRIPTION_EVENTS_HEARTBEAT_MS)
    try {
      await Promise.race([transcriptionEventsHub.start(), done])
      if (closed) return
      await stream.write(`retry: ${TRANSCRIPTION_EVENTS_RETRY_MS}\n\n`)
      const rows = await Promise.race([listJobs(componentId, userId), done])
      if (closed || !rows) return
      await stream.writeSSE({
        event: 'jobs',
        data: JSON.stringify({ jobs: rows.map((row) => publicJob(row, false)) })
      })
      buffering = false
      for (const event of buffered) send(event)
      buffered.length = 0
      await done
    } finally {
      close()
      unsubscribe()
      clearTimeout(maxAge)
      clearInterval(heartbeat)
      context.req.raw.signal.removeEventListener('abort', close)
    }
  })
  // streamSSE sets Cache-Control itself; override it on the returned response.
  response.headers.set('Cache-Control', 'no-cache, no-transform')
  return response
})
