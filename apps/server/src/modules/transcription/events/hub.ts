import type { TranscriptionEvent } from '@justcampus/shared'
import { z } from 'zod'

import { client } from '../../../db/index.js'
import { publicJob } from '../jobs/rows.js'
import { findJob } from '../jobs/store.js'

export const TRANSCRIPTION_EVENTS_CHANNEL = 'transcription_events'

const notificationSchema = z.object({
  type: z.enum(['job', 'transcriptMetadata']),
  id: z.uuid(),
  componentId: z.uuid(),
  userId: z.string().min(1)
})

type Subscriber = { send: (event: TranscriptionEvent) => void; close: () => void }
type Audience = {
  subscribers: Set<Subscriber>
  pending: Promise<void>
}

interface EventsHub {
  start: () => ReturnType<typeof client.listen>
  subscribe: (componentId: string, userId: string, subscriber: Subscriber) => () => void
  stop: () => void
}

/** One LISTEN connection per process, with ordered loads for each user's streams. */
export function createTranscriptionEventsHub(): EventsHub {
  const audiences = new Map<string, Audience>()
  let listening: ReturnType<typeof client.listen> | undefined
  let stopped = false
  let connected = false
  let generation = 0
  const keyOf = (componentId: string, userId: string): string =>
    JSON.stringify([componentId, userId])

  function enqueue(audience: Audience, load: () => Promise<TranscriptionEvent>): void {
    const currentGeneration = generation
    audience.pending = audience.pending
      .then(async () => {
        if (stopped || currentGeneration !== generation || audience.subscribers.size === 0) return
        const event = await load()
        if (!stopped && currentGeneration === generation)
          for (const subscriber of audience.subscribers) subscriber.send(event)
      })
      .catch((error: unknown) => {
        console.error('Transcription event could not be loaded', error)
        // Reconnect with a snapshot after a failed load instead of silently missing a change.
        for (const subscriber of audience.subscribers) subscriber.close()
      })
  }

  function start(): ReturnType<typeof client.listen> {
    if (listening) return listening
    stopped = false
    const currentGeneration = ++generation
    const connection = client.listen(
      TRANSCRIPTION_EVENTS_CHANNEL,
      (payload) => {
        if (stopped || currentGeneration !== generation) return
        let parsed: unknown
        try {
          parsed = JSON.parse(payload)
        } catch {
          return
        }
        const notification = notificationSchema.safeParse(parsed)
        if (!notification.success) return
        const { type, id, componentId, userId } = notification.data
        const audience = audiences.get(keyOf(componentId, userId))
        if (!audience) return
        enqueue(audience, async () => {
          if (type === 'transcriptMetadata') return { type, data: { id } }
          const row = await findJob(id, componentId, userId)
          return row
            ? { type: 'job', data: publicJob(row, false) }
            : { type: 'jobRemoved', data: { id } }
        })
      },
      () => {
        if (stopped || currentGeneration !== generation) return
        // Notifications sent while the listener was away are lost. A snapshot alone would not
        // bring back a missed `completed` or `transcriptMetadata`, so the streams end after the
        // pending loads, and each browser resyncs on its reconnect as after any other drop.
        if (connected) {
          for (const audience of audiences.values()) {
            audience.pending = audience.pending.then(() => {
              for (const subscriber of audience.subscribers) subscriber.close()
            })
          }
        }
        connected = true
      }
    )
    const pending = connection.catch((error: unknown) => {
      if (listening === pending) listening = undefined
      throw error
    })
    listening = pending
    return pending
  }

  function subscribe(componentId: string, userId: string, subscriber: Subscriber): () => void {
    const key = keyOf(componentId, userId)
    let audience = audiences.get(key)
    if (!audience) {
      audience = { subscribers: new Set(), pending: Promise.resolve() }
      audiences.set(key, audience)
    }
    audience.subscribers.add(subscriber)
    return () => {
      audience.subscribers.delete(subscriber)
      if (audience.subscribers.size === 0 && audiences.get(key) === audience) audiences.delete(key)
    }
  }

  function stop(): void {
    stopped = true
    generation++
    for (const audience of audiences.values()) {
      for (const subscriber of audience.subscribers) subscriber.close()
    }
    audiences.clear()
    const connection = listening
    listening = undefined
    connected = false
    if (connection) {
      void connection
        .then(({ unlisten }) => unlisten())
        .catch((error: unknown) => {
          console.error('Transcription event listener could not be stopped', error)
        })
    }
  }

  return { start, subscribe, stop }
}

export const transcriptionEventsHub = createTranscriptionEventsHub()
