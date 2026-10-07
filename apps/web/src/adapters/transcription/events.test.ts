import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryObserver, type QueryKey } from '@tanstack/react-query'
import type { TranscriptionEvent, TranscriptionJob } from '@justcampus/shared'
import { applyTranscriptionEvent, syncTranscriptionCaches, transcriptionKeys } from './api'
import { createTranscriptionEvents, parseTranscriptionEvent, type EventStream } from './events'
import { fakeEvents } from './fake-events'

const JOB_ID = '6f4d0b7c-2a4e-4b8e-9a51-1d1f1c3e5a77'
const NOW = '2026-10-04T10:00:00.000Z'

function job(change: Partial<TranscriptionJob> = {}): TranscriptionJob {
  return {
    id: JOB_ID,
    filename: 'a.wav',
    size: 10,
    mimeType: 'audio/wav',
    duration: 12,
    groupId: null,
    groupOrder: 0,
    settings: { language: 'auto', speakerCount: 'auto', llmCorrection: true },
    status: 'analyzing',
    progress: null,
    speakers: [],
    mapping: {},
    snippets: [],
    colors: {},
    error: null,
    result: null,
    transcriptId: null,
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: null,
    ...change
  }
}

/** A stand-in `EventSource`, driven by hand. */
class FakeStream implements EventStream {
  readyState = 0
  closed = false
  private readonly listeners = new Map<string, ((event: Event) => void)[]>()

  addEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  close(): void {
    this.closed = true
    this.readyState = 2
  }

  private fire(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  open(): void {
    this.readyState = 1
    this.fire('open', new Event('open'))
  }

  /** The connection dropped; `closed`: the browser gave up reconnecting. */
  fail(closed: boolean): void {
    this.readyState = closed ? 2 : 0
    this.fire('error', new Event('error'))
  }

  send(type: string, data: unknown): void {
    this.fire(type, new MessageEvent(type, { data: JSON.stringify(data) }))
  }
}

describe('parseTranscriptionEvent', () => {
  it('takes data as the contract describes it and nothing else', () => {
    expect(parseTranscriptionEvent('jobRemoved', JSON.stringify({ id: JOB_ID }))).toEqual({
      type: 'jobRemoved',
      data: { id: JOB_ID }
    })
    expect(parseTranscriptionEvent('jobRemoved', JSON.stringify({ id: 'x' }))).toBeNull()
    expect(parseTranscriptionEvent('job', '{')).toBeNull()
    expect(parseTranscriptionEvent('jobs', undefined)).toBeNull()
  })
})

describe('createTranscriptionEvents', () => {
  let streams: FakeStream[]
  const events = (): ReturnType<typeof createTranscriptionEvents> =>
    createTranscriptionEvents({
      connect: () => {
        const stream = new FakeStream()
        streams.push(stream)
        return stream
      },
      retryMs: 1000,
      maxRetryMs: 3000,
      graceMs: 500
    })

  beforeEach(() => {
    vi.useFakeTimers()
    streams = []
  })
  afterEach(() => vi.useRealTimers())

  it('opens one stream for all subscribers and closes it shortly after the last left', async () => {
    const client = events()
    const first = { onEvent: vi.fn(), onOpen: vi.fn() }
    const stopFirst = client.subscribe(first)
    expect(streams).toHaveLength(1)
    streams[0]!.open()
    expect(first.onOpen).toHaveBeenCalledOnce()

    const second = { onEvent: vi.fn(), onOpen: vi.fn() }
    const stopSecond = client.subscribe(second)
    // Open already: the late subscriber syncs at once.
    await vi.advanceTimersByTimeAsync(0)
    expect(second.onOpen).toHaveBeenCalledOnce()
    expect(streams).toHaveLength(1)

    streams[0]!.send('jobRemoved', { id: JOB_ID })
    streams[0]!.send('jobRemoved', { id: 'not a uuid' })
    expect(first.onEvent).toHaveBeenCalledExactlyOnceWith({
      type: 'jobRemoved',
      data: { id: JOB_ID }
    })
    expect(second.onEvent).toHaveBeenCalledOnce()

    stopFirst()
    stopSecond()
    await vi.advanceTimersByTimeAsync(400)
    // Back within the grace time: the same stream goes on.
    const stopThird = client.subscribe({})
    await vi.advanceTimersByTimeAsync(1000)
    expect(streams[0]!.closed).toBe(false)
    stopThird()
    await vi.advanceTimersByTimeAsync(500)
    expect(streams[0]!.closed).toBe(true)
    expect(streams).toHaveLength(1)
  })

  it('lets the browser reconnect, and syncs each time it did', () => {
    const client = events()
    const handlers = { onOpen: vi.fn() }
    client.subscribe(handlers)
    streams[0]!.open()
    streams[0]!.fail(false)
    streams[0]!.open()
    expect(handlers.onOpen).toHaveBeenCalledTimes(2)
    expect(streams).toHaveLength(1)
  })

  it('connects anew with a growing wait once the browser gave up', async () => {
    const client = events()
    const handlers = { onOpen: vi.fn() }
    client.subscribe(handlers)
    streams[0]!.fail(true)
    expect(streams[0]!.closed).toBe(true)
    await vi.advanceTimersByTimeAsync(999)
    expect(streams).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(streams).toHaveLength(2)
    streams[1]!.fail(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(streams).toHaveLength(3)
    streams[2]!.fail(true)
    await vi.advanceTimersByTimeAsync(3000)
    expect(streams).toHaveLength(4)
    streams[3]!.fail(true)
    await vi.advanceTimersByTimeAsync(3000)
    expect(streams).toHaveLength(5)
    // A connection that opened starts the wait over.
    streams[4]!.open()
    expect(handlers.onOpen).toHaveBeenCalledOnce()
    streams[4]!.fail(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(streams).toHaveLength(6)
  })

  it('does not connect again once nobody listens', async () => {
    const client = events()
    const stop = client.subscribe({})
    streams[0]!.fail(true)
    stop()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(streams).toHaveLength(1)
  })
})

describe('the job caches (T-15)', () => {
  const send = (client: QueryClient, event: TranscriptionEvent): void =>
    applyTranscriptionEvent(client, event)

  it('takes the snapshot, changes, saved and removed jobs into the list', () => {
    const client = new QueryClient()
    const other = job({ id: '1d1f1c3e-2a4e-4b8e-9a51-6f4d0b7c5a77' })
    send(client, { type: 'jobs', data: { jobs: [job()] } })
    expect(client.getQueryData(transcriptionKeys.jobs)).toEqual([job()])

    send(client, { type: 'job', data: other })
    send(client, { type: 'job', data: job({ status: 'analyzed' }) })
    expect(client.getQueryData(transcriptionKeys.jobs)).toEqual([
      job({ status: 'analyzed' }),
      other
    ])

    send(client, { type: 'job', data: { ...other, transcriptId: JOB_ID } })
    expect(client.getQueryData(transcriptionKeys.jobs)).toEqual([job({ status: 'analyzed' })])

    send(client, { type: 'jobRemoved', data: { id: JOB_ID } })
    send(client, { type: 'job', data: job({ status: 'cancelled' }) })
    expect(client.getQueryData(transcriptionKeys.jobs)).toEqual([])
  })

  it('keeps the result of a cached job and fetches one completed without', () => {
    const client = new QueryClient()
    const id = '2a4e6f4d-0b7c-4b8e-9a51-1d1f1c3e5a77'
    const result = {
      text: 'A',
      language: 'de',
      duration: 5,
      segments: [],
      words: [],
      model: null,
      provider: null
    }
    client.setQueryData(transcriptionKeys.job(id), job({ id, status: 'completed', result }))
    send(client, { type: 'job', data: job({ id, status: 'completed', transcriptId: JOB_ID }) })
    expect(client.getQueryData<TranscriptionJob>(transcriptionKeys.job(id))).toMatchObject({
      transcriptId: JOB_ID,
      result
    })
    expect(client.getQueryState(transcriptionKeys.job(id))?.isInvalidated).toBe(false)

    client.setQueryData(transcriptionKeys.job(id), job({ id, status: 'optimizing' }))
    send(client, { type: 'job', data: job({ id, status: 'completed' }) })
    expect(client.getQueryState(transcriptionKeys.job(id))?.isInvalidated).toBe(true)
  })

  describe('with a GET underway', () => {
    const result = {
      text: 'A',
      language: 'de',
      duration: 5,
      segments: [],
      words: [],
      model: null,
      provider: null
    }

    /** A query observed like a widget does; the test answers each of its GETs by hand. */
    function observe<T>(
      client: QueryClient,
      queryKey: QueryKey
    ): { answers: ((value: T) => void)[]; observer: QueryObserver<T>; close: () => void } {
      const answers: ((value: T) => void)[] = []
      const observer = new QueryObserver<T>(client, {
        queryKey,
        queryFn: () => new Promise<T>((resolve) => answers.push(resolve)),
        retry: false
      })
      const close = observer.subscribe(() => {})
      return { answers, observer, close }
    }

    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve))

    it('keeps a completion in the list from an older answer', async () => {
      const client = new QueryClient()
      const id = '3c1e5a77-6f4d-4b8e-9a51-1d1f0b7c2a4e'
      const list = observe<TranscriptionJob[]>(client, transcriptionKeys.jobs)
      list.answers[0]!([job({ id, status: 'transcribing' })])
      await settle()
      void list.observer.refetch()
      send(client, { type: 'job', data: job({ id, status: 'completed' }) })
      list.answers[1]!([job({ id, status: 'transcribing' })])
      await settle()
      expect(client.getQueryData(transcriptionKeys.jobs)).toEqual([
        job({ id, status: 'completed' })
      ])
      expect(list.answers).toHaveLength(2)
      list.close()
    })

    it('does not bring a removed job back into the list', async () => {
      const client = new QueryClient()
      const id = '4e5a771d-1f1c-4b8e-9a51-6f4d0b7c2a4e'
      const list = observe<TranscriptionJob[]>(client, transcriptionKeys.jobs)
      send(client, { type: 'jobRemoved', data: { id } })
      // The first GET had nothing to change, so the list is fetched again.
      expect(list.answers).toHaveLength(2)
      list.answers[0]!([job({ id, status: 'transcribing' })])
      await settle()
      expect(client.getQueryData(transcriptionKeys.jobs)).toBeUndefined()
      list.answers[1]!([])
      await settle()
      expect(client.getQueryData(transcriptionKeys.jobs)).toEqual([])
      list.close()
    })

    it('keeps a step in the detail from an older answer', async () => {
      const client = new QueryClient()
      const id = '8b5f1d1f-1c3e-4b8e-9a51-5a776f4d0b7c'
      const detail = observe<TranscriptionJob>(client, transcriptionKeys.job(id))
      detail.answers[0]!(job({ id, status: 'transcribing' }))
      await settle()
      void detail.observer.refetch()
      send(client, { type: 'job', data: job({ id, status: 'optimizing' }) })
      detail.answers[1]!(job({ id, status: 'transcribing' }))
      await settle()
      expect(client.getQueryData(transcriptionKeys.job(id))).toMatchObject({ status: 'optimizing' })
      expect(detail.answers).toHaveLength(2)
      detail.close()
    })

    it('keeps a completion in the detail and fetches its result', async () => {
      const client = new QueryClient()
      const id = '5a771d1f-1c3e-4b8e-9a51-6f4d0b7c2a4e'
      const detail = observe<TranscriptionJob>(client, transcriptionKeys.job(id))
      detail.answers[0]!(job({ id, status: 'transcribing' }))
      await settle()
      void detail.observer.refetch()
      send(client, { type: 'job', data: job({ id, status: 'completed' }) })
      expect(client.getQueryData(transcriptionKeys.job(id))).toMatchObject({ status: 'completed' })
      detail.answers[1]!(job({ id, status: 'transcribing' }))
      await settle()
      expect(client.getQueryData(transcriptionKeys.job(id))).toMatchObject({ status: 'completed' })
      detail.answers[2]!(job({ id, status: 'completed', result }))
      await settle()
      expect(client.getQueryData(transcriptionKeys.job(id))).toMatchObject({ result })
      detail.close()
    })

    it('fetches a detail again whose first GET an event overtook', async () => {
      const client = new QueryClient()
      const id = '6f4d1d1f-1c3e-4b8e-9a51-5a770b7c2a4e'
      const detail = observe<TranscriptionJob>(client, transcriptionKeys.job(id))
      send(client, { type: 'job', data: job({ id, status: 'completed' }) })
      expect(detail.answers).toHaveLength(2)
      detail.answers[0]!(job({ id, status: 'transcribing' }))
      await settle()
      expect(client.getQueryData(transcriptionKeys.job(id))).toBeUndefined()
      detail.answers[1]!(job({ id, status: 'completed', result }))
      await settle()
      expect(client.getQueryData(transcriptionKeys.job(id))).toMatchObject({ result })
      detail.close()
    })

    it('does not take a removed job from an older detail answer', async () => {
      const client = new QueryClient()
      const id = '7a4e1d1f-1c3e-4b8e-9a51-5a776f4d0b7c'
      const detail = observe<TranscriptionJob>(client, transcriptionKeys.job(id))
      detail.answers[0]!(job({ id, status: 'transcribing' }))
      await settle()
      void detail.observer.refetch()
      send(client, { type: 'jobRemoved', data: { id } })
      expect(detail.answers).toHaveLength(3)
      detail.answers[1]!(job({ id, status: 'completed', result }))
      await settle()
      expect(client.getQueryData(transcriptionKeys.job(id))).toMatchObject({
        status: 'transcribing'
      })
      detail.close()
    })
  })

  it('listens once per query client while anyone wants the caches current', () => {
    const client = new QueryClient()
    const events = fakeEvents()
    const stopFirst = syncTranscriptionCaches(client, events)
    const stopSecond = syncTranscriptionCaches(client, events)
    expect(events.subscribers).toBe(1)
    events.emit({ type: 'jobs', data: { jobs: [] } })
    expect(client.getQueryData(transcriptionKeys.jobs)).toEqual([])
    stopFirst()
    stopFirst()
    expect(events.subscribers).toBe(1)
    stopSecond()
    expect(events.subscribers).toBe(0)
  })
})
