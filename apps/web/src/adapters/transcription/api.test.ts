import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import type { TranscriptionTranscript, TranscriptionTranscriptSummary } from '@justcampus/shared'
import { ApiRequestError } from '@/lib/api'
import {
  awaitGeneratedTitle,
  fetchAdminModels,
  liveSocketUrl,
  mediaUrlExpiresSoon,
  transcriptionKeys,
  UploadError,
  uploadToTarget
} from './api'
import { fakeEvents } from './fake-events'

/** A stand-in for `XMLHttpRequest` that finishes as `outcome` says when sent. */
function stubXhr(outcome: { status?: number; error?: boolean }): {
  headers: Record<string, string>
} {
  const seen = { headers: {} as Record<string, string> }
  class FakeRequest {
    status = 0
    upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null }
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    onabort: (() => void) | null = null
    open(): void {
      // Nothing to open: `send` decides how the request ends.
    }
    setRequestHeader(name: string, value: string): void {
      seen.headers[name] = value
    }
    abort(): void {
      this.onabort?.()
    }
    send(): void {
      this.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 } as ProgressEvent)
      if (outcome.error) this.onerror?.()
      else {
        this.status = outcome.status ?? 200
        this.onload?.()
      }
    }
  }
  vi.stubGlobal('XMLHttpRequest', FakeRequest)
  return seen
}

const target = {
  url: 'http://localhost:9100/bucket/key?X-Amz-Signature=x',
  method: 'PUT' as const,
  headers: { 'Content-Type': 'audio/wav' },
  expiresAt: '2026-10-04T09:00:00.000Z'
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('uploadToTarget', () => {
  it('sends the signed headers and reports progress to the end', async () => {
    const seen = stubXhr({ status: 200 })
    const progress: number[] = []
    await uploadToTarget(target, new Blob(['x']), {
      onProgress: (value) => progress.push(value)
    })
    expect(seen.headers).toEqual({ 'Content-Type': 'audio/wav' })
    expect(progress).toEqual([0.5, 1])
  })

  it('tells a storage status, a network failure and an abort apart (T-16)', async () => {
    stubXhr({ status: 403 })
    await expect(uploadToTarget(target, new Blob(['x']))).rejects.toMatchObject({
      kind: 'status',
      status: 403
    })
    stubXhr({ error: true })
    await expect(uploadToTarget(target, new Blob(['x']))).rejects.toMatchObject({
      kind: 'network'
    })
    const controller = new AbortController()
    controller.abort()
    await expect(
      uploadToTarget(target, new Blob(['x']), { signal: controller.signal })
    ).rejects.toBeInstanceOf(UploadError)
  })
})

describe('mediaUrlExpiresSoon', () => {
  it('asks for a fresh URL five minutes before expiry (T-21)', () => {
    const now = Date.parse('2026-10-04T08:00:00.000Z')
    expect(mediaUrlExpiresSoon({ url: 'x', expiresAt: '2026-10-04T08:04:59.000Z' }, now)).toBe(true)
    expect(mediaUrlExpiresSoon({ url: 'x', expiresAt: '2026-10-04T08:05:01.000Z' }, now)).toBe(
      false
    )
  })
})

describe('fetchAdminModels', () => {
  it('passes the models of the kind and how many others the endpoint has', async () => {
    const fetch = vi.fn(async () =>
      Response.json({ models: [{ id: 'jlu/whisper-1', label: 'Whisper' }], leftOut: 3 })
    )
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('window', {})
    expect(await fetchAdminModels({ kind: 'asr', baseUrl: 'https://api.example.org/v1' })).toEqual({
      models: [{ id: 'jlu/whisper-1', label: 'Whisper' }],
      leftOut: 3
    })
    // A server without the count: none left out.
    fetch.mockResolvedValueOnce(Response.json({ models: [] }))
    expect(await fetchAdminModels({ kind: 'llm', baseUrl: 'https://api.example.org/v1' })).toEqual({
      models: [],
      leftOut: 0
    })
  })
})

describe('liveSocketUrl', () => {
  it('opens the live socket on the API origin, else the page’s, over ws or wss', () => {
    expect(liveSocketUrl('onprem', '', 'https://campus.example/transcription')).toBe(
      'wss://campus.example/api/modules/transcription/live?mode=onprem'
    )
    expect(liveSocketUrl('openai', 'http://localhost:3000', 'http://localhost:5173/')).toBe(
      'ws://localhost:3000/api/modules/transcription/live?mode=openai'
    )
    expect(liveSocketUrl('onprem', 'https://api.campus.example', 'app://-/index.html')).toBe(
      'wss://api.campus.example/api/modules/transcription/live?mode=onprem'
    )
  })
})

describe('awaitGeneratedTitle', () => {
  const saved: TranscriptionTranscript = {
    id: '0b7c2a4e-6f4d-4b8e-9a51-1d1f1c3e5a77',
    title: 'alice-20261007-154501',
    subtitle: null,
    subtitleSource: null,
    language: 'de',
    duration: 20,
    originalFilename: 'alice-20261007-154501.webm',
    createdAt: '2026-10-07T13:45:01.000Z',
    updatedAt: '2026-10-07T13:45:01.000Z',
    expiresAt: null,
    model: null,
    provider: null,
    fileSize: null,
    text: '',
    segments: [],
    words: [],
    sourceFiles: [],
    speakerColors: {},
    summaryTemplateId: null,
    revision: 1
  }
  const summary = (transcript: TranscriptionTranscript): TranscriptionTranscriptSummary => ({
    id: transcript.id,
    title: transcript.title,
    subtitle: transcript.subtitle,
    language: transcript.language,
    duration: transcript.duration,
    originalFilename: transcript.originalFilename,
    createdAt: transcript.createdAt,
    updatedAt: transcript.updatedAt,
    expiresAt: transcript.expiresAt
  })
  const named = { ...saved, title: 'Gießener Transkriptionstest' }
  const done = { ...named, subtitle: 'Ein Test', subtitleSource: 'ai' as const }

  function cached(detail: TranscriptionTranscript = saved): QueryClient {
    const client = new QueryClient()
    client.setQueryData(transcriptionKeys.transcript(saved.id), detail)
    client.setQueryData(transcriptionKeys.transcripts, [summary(saved)])
    return client
  }
  const listed = (client: QueryClient): TranscriptionTranscriptSummary | undefined =>
    client.getQueryData<TranscriptionTranscriptSummary[]>(transcriptionKeys.transcripts)?.[0]

  const metadata = { type: 'transcriptMetadata', data: { id: saved.id } } as const

  afterEach(() => {
    vi.useRealTimers()
  })

  it('brings the AI title into the history without the transcript open (T-23)', async () => {
    vi.useFakeTimers()
    const client = cached()
    const events = fakeEvents(false)
    const answers = [named, done]
    const get = vi.fn(async () => answers.shift() ?? done)
    const onTitle = vi.fn()
    awaitGeneratedTitle(client, saved, { get, onTitle, events })
    expect(events.subscribers).toBe(1)
    // A (re)connect fetches in case the event came before: the title first, the wait goes on.
    events.setOpen(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(listed(client)).toMatchObject({ title: named.title, subtitle: null })
    expect(onTitle).toHaveBeenCalledTimes(1)
    expect(events.subscribers).toBe(1)
    // The chat model is done.
    events.emit(metadata)
    await vi.advanceTimersByTimeAsync(0)
    expect(listed(client)).toMatchObject({ title: named.title, subtitle: 'Ein Test' })
    expect(client.getQueryData(transcriptionKeys.transcript(saved.id))).toMatchObject({
      title: named.title,
      subtitle: 'Ein Test',
      subtitleSource: 'ai'
    })
    expect(get).toHaveBeenCalledTimes(2)
    expect(onTitle).toHaveBeenCalledTimes(1)
    expect(events.subscribers).toBe(0)
  })

  it('ignores the events of other transcripts and stops waiting after a minute', async () => {
    vi.useFakeTimers()
    const events = fakeEvents()
    const get = vi.fn(async () => saved)
    awaitGeneratedTitle(cached(), saved, { get, events })
    await vi.advanceTimersByTimeAsync(0)
    expect(get).toHaveBeenCalledTimes(1)
    events.emit({
      type: 'transcriptMetadata',
      data: { id: '1d1f1c3e-6f4d-4b8e-9a51-0b7c2a4e5a77' }
    })
    await vi.advanceTimersByTimeAsync(59_000)
    expect(get).toHaveBeenCalledTimes(1)
    expect(events.subscribers).toBe(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(events.subscribers).toBe(0)
  })

  it('drops the late answer of a wait a newer save replaced, or of an earlier fetch', async () => {
    vi.useFakeTimers()
    const client = cached()
    const events = fakeEvents()
    let answer: (latest: TranscriptionTranscript) => void = () => undefined
    const stale = vi.fn(
      () =>
        new Promise<TranscriptionTranscript>((resolve) => {
          answer = resolve
        })
    )
    awaitGeneratedTitle(client, saved, { get: stale, events })
    await vi.advanceTimersByTimeAsync(0)
    expect(stale).toHaveBeenCalledTimes(1)
    // Saved again while the first wait's request is under way; the new wait finds the AI title.
    const onTitle = vi.fn()
    awaitGeneratedTitle(client, saved, { get: vi.fn(async () => done), onTitle, events })
    events.emit(metadata)
    await vi.advanceTimersByTimeAsync(0)
    expect(listed(client)).toMatchObject({ title: done.title, subtitle: 'Ein Test' })
    expect(onTitle).toHaveBeenCalledTimes(1)
    // The replaced wait's answer comes last, still with the saved title.
    answer(saved)
    await vi.advanceTimersByTimeAsync(0)
    expect(listed(client)).toMatchObject({ title: done.title, subtitle: 'Ein Test' })
    expect(client.getQueryData(transcriptionKeys.transcript(saved.id))).toMatchObject({
      title: done.title,
      subtitle: 'Ein Test'
    })
    expect(events.subscribers).toBe(0)

    // Within one wait, the first reconnect's fetch answers after the second's.
    const other = cached()
    const reconnecting = fakeEvents(false)
    const slow: ((latest: TranscriptionTranscript) => void)[] = []
    const get = vi.fn((): Promise<TranscriptionTranscript> => {
      if (get.mock.calls.length > 1) return Promise.resolve(named)
      return new Promise((resolve) => slow.push(resolve))
    })
    awaitGeneratedTitle(other, saved, { get, events: reconnecting })
    reconnecting.setOpen(true)
    reconnecting.setOpen(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(listed(other)?.title).toBe(named.title)
    slow[0]?.(saved)
    await vi.advanceTimersByTimeAsync(0)
    expect(listed(other)?.title).toBe(named.title)
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('leaves a copy edited meanwhile alone, and stops when the transcript is gone', async () => {
    vi.useFakeTimers()
    const edited = { ...saved, title: 'Mein Titel', revision: 2 }
    const client = cached(edited)
    const events = fakeEvents()
    awaitGeneratedTitle(client, saved, { get: vi.fn(async () => done), events })
    events.emit(metadata)
    await vi.advanceTimersByTimeAsync(0)
    expect(client.getQueryData(transcriptionKeys.transcript(saved.id))).toEqual(edited)
    expect(listed(client)?.title).toBe(saved.title)

    const gone = vi.fn(async () => {
      throw new ApiRequestError(404, null)
    })
    awaitGeneratedTitle(cached(), saved, { get: gone, events })
    await vi.advanceTimersByTimeAsync(0)
    expect(gone).toHaveBeenCalledTimes(1)
    expect(events.subscribers).toBe(0)
  })
})
