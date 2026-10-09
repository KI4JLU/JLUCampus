import type { TranscriptionEvent } from '@justcampus/shared'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AppEnvironment } from '../../types.js'

const state = vi.hoisted(() => ({
  send: (() => {}) as (event: TranscriptionEvent) => void,
  close: () => {},
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  list: vi.fn(),
  start: vi.fn(),
  access: vi.fn()
}))
vi.mock('./hub.js', () => ({
  transcriptionEventsHub: {
    start: state.start,
    subscribe: state.subscribe.mockImplementation((_componentId, _userId, subscriber) => {
      state.send = subscriber.send
      state.close = subscriber.close
      return state.unsubscribe
    })
  }
}))
vi.mock('../jobs/store.js', () => ({ listJobs: state.list }))
vi.mock('../jobs/rows.js', () => ({ publicJob: (row: unknown) => row }))
vi.mock('../../context.js', () => ({ getModuleRuntime: () => ({ componentId: 'component' }) }))
vi.mock('../realtime/access.js', () => ({ hasModuleAccess: state.access }))

import {
  eventsRouter,
  TRANSCRIPTION_EVENTS_ACCESS_CHECK_MS,
  TRANSCRIPTION_EVENTS_MAX_AGE_MS
} from './index.js'

const app = new Hono<AppEnvironment>()
app.use('*', (context, next) => {
  context.set('session', { user: { id: 'user' } } as AppEnvironment['Variables']['session'])
  return next()
})
app.route('/', eventsRouter)
const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

beforeEach(() => {
  state.unsubscribe.mockReset()
  state.subscribe.mockClear()
  state.start.mockReset().mockResolvedValue(undefined)
  state.list.mockReset().mockResolvedValue([])
  state.access.mockReset().mockResolvedValue(true)
})
afterEach(() => {
  state.close()
  vi.useRealTimers()
})

async function reader(): Promise<{
  response: Response
  reader: ReadableStreamDefaultReader<Uint8Array>
  read: () => Promise<string>
}> {
  const response = await app.request('/events')
  const reader = response.body!.getReader()
  const read = async (): Promise<string> => new TextDecoder().decode((await reader.read()).value)
  return { response, reader, read }
}

describe('transcription event stream', () => {
  it('subscribes before loading and sends the snapshot before buffered job changes', async () => {
    let resolve!: (rows: unknown[]) => void
    state.list.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    const { response, read, reader: stream } = await reader()
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    expect(response.headers.get('cache-control')).toBe('no-cache, no-transform')
    expect(response.headers.get('x-accel-buffering')).toBe('no')
    expect(await read()).toBe('retry: 3000\n\n')
    await flush()
    expect(state.subscribe).toHaveBeenCalledWith('component', 'user', expect.anything())
    state.send({ type: 'jobRemoved', data: { id: 'removed' } })
    resolve([{ id: 'initial' }])
    expect(await read()).toBe('event: jobs\ndata: {"jobs":[{"id":"initial"}]}\n\n')
    expect(await read()).toBe('event: jobRemoved\ndata: {"id":"removed"}\n\n')
    state.send({ type: 'jobs', data: { jobs: [] } })
    expect(await read()).toBe('event: jobs\ndata: {"jobs":[]}\n\n')
    await stream.cancel()
    await flush()
    expect(state.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('forwards job and metadata events in order', async () => {
    const { read, reader: stream } = await reader()
    await read()
    await read()
    const job = { id: 'changed', transcriptId: 'saved', result: null }
    state.send({ type: 'job', data: job } as TranscriptionEvent)
    state.send({ type: 'transcriptMetadata', data: { id: 'transcript' } })
    expect(await read()).toBe(`event: job\ndata: ${JSON.stringify(job)}\n\n`)
    expect(await read()).toBe('event: transcriptMetadata\ndata: {"id":"transcript"}\n\n')
    await stream.cancel()
  })

  it('sends heartbeat comments and closes at the maximum age', async () => {
    vi.useFakeTimers()
    const { read, reader: stream } = await reader()
    await read()
    await read()
    await vi.advanceTimersByTimeAsync(25_000)
    expect(await read()).toBe(': heartbeat\n\n')
    const draining = (async () => {
      while (!(await stream.read()).done) {
        /* drain heartbeats */
      }
    })()
    await vi.advanceTimersByTimeAsync(TRANSCRIPTION_EVENTS_MAX_AGE_MS - 25_000)
    await draining
    expect(state.unsubscribe).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('closes once the user may no longer use the component', async () => {
    vi.useFakeTimers()
    const { read, reader: stream } = await reader()
    await read()
    await read()
    const draining = (async () => {
      while (!(await stream.read()).done) {
        /* drain heartbeats */
      }
    })()
    await vi.advanceTimersByTimeAsync(TRANSCRIPTION_EVENTS_ACCESS_CHECK_MS)
    expect(state.access).toHaveBeenCalledWith('user', 'component')
    expect(state.unsubscribe).not.toHaveBeenCalled()
    state.access.mockResolvedValue(false)
    await vi.advanceTimersByTimeAsync(TRANSCRIPTION_EVENTS_ACCESS_CHECK_MS)
    await draining
    expect(state.unsubscribe).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases subscriptions when the initial snapshot stalls past maximum age', async () => {
    vi.useFakeTimers()
    state.list.mockImplementation(() => new Promise(() => {}))
    const { read, reader: stream } = await reader()
    await read()
    const draining = (async () => {
      while (!(await stream.read()).done) {
        /* drain heartbeats */
      }
    })()
    await vi.advanceTimersByTimeAsync(TRANSCRIPTION_EVENTS_MAX_AGE_MS)
    await draining
    expect(state.unsubscribe).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases subscriptions at maximum age even when the reader stops consuming', async () => {
    vi.useFakeTimers()
    const { reader: stream } = await reader()
    await vi.advanceTimersByTimeAsync(TRANSCRIPTION_EVENTS_MAX_AGE_MS)
    expect(state.unsubscribe).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    while (!(await stream.read()).done) {
      /* drain the response buffer */
    }
  })

  it('closes when the listener stops', async () => {
    const { read, reader: stream } = await reader()
    await read()
    await read()
    state.close()
    expect((await stream.read()).done).toBe(true)
    await flush()
    expect(state.unsubscribe).toHaveBeenCalledTimes(1)
  })
})
