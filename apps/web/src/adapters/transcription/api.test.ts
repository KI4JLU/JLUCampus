import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchAdminModels,
  liveSocketUrl,
  mediaUrlExpiresSoon,
  SignedUploadError,
  uploadToSignedUrl
} from './api'

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

describe('uploadToSignedUrl', () => {
  it('sends the signed headers and reports progress to the end', async () => {
    const seen = stubXhr({ status: 200 })
    const progress: number[] = []
    await uploadToSignedUrl(target, new Blob(['x']), {
      onProgress: (value) => progress.push(value)
    })
    expect(seen.headers).toEqual({ 'Content-Type': 'audio/wav' })
    expect(progress).toEqual([0.5, 1])
  })

  it('tells a storage status, a network failure and an abort apart (T-16)', async () => {
    stubXhr({ status: 403 })
    await expect(uploadToSignedUrl(target, new Blob(['x']))).rejects.toMatchObject({
      kind: 'status',
      status: 403
    })
    stubXhr({ error: true })
    await expect(uploadToSignedUrl(target, new Blob(['x']))).rejects.toMatchObject({
      kind: 'network'
    })
    const controller = new AbortController()
    controller.abort()
    await expect(
      uploadToSignedUrl(target, new Blob(['x']), { signal: controller.signal })
    ).rejects.toBeInstanceOf(SignedUploadError)
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
