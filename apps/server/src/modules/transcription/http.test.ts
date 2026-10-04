import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { ApiError } from '../../api.js'
import {
  bearer,
  ensureOk,
  fetchJson,
  parseModels,
  upstream,
  UpstreamError,
  upstreamFetch,
  upstreamUrl
} from './http.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('upstreamUrl and bearer', () => {
  it('joins with one slash and adds a key only when there is one', () => {
    expect(upstreamUrl('http://localhost:9200/asr/v1/', '/audio/transcriptions')).toBe(
      'http://localhost:9200/asr/v1/audio/transcriptions'
    )
    expect(bearer('sk')).toEqual({ Authorization: 'Bearer sk' })
    expect(bearer(null)).toEqual({})
  })
})

describe('upstreamFetch', () => {
  it('refuses redirects and passes a signal', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    await upstreamFetch('https://asr.example/v1/models')
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(init.redirect).toBe('error')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('turns network failures into an upstream error without the cause in its message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      })
    )
    await expect(upstreamFetch('https://asr.example/v1/models')).rejects.toMatchObject({
      name: 'UpstreamError',
      message: 'asr.example is unreachable',
      status: null
    })
  })

  it('rethrows the caller abort as it is', async () => {
    const controller = new AbortController()
    controller.abort(new Error('client gone'))
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('aborted', 'AbortError')
      })
    )
    await expect(
      upstreamFetch('https://asr.example/v1/models', { signal: controller.signal })
    ).rejects.toThrow('client gone')
  })
})

describe('ensureOk and fetchJson', () => {
  it('keeps status and the start of the body', async () => {
    const error = await ensureOk(
      new Response('Unsupported Media Type', { status: 415 }),
      'The diarisation'
    ).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(UpstreamError)
    expect(error).toMatchObject({
      message: 'The diarisation answered with status 415',
      status: 415,
      detail: 'Unsupported Media Type'
    })
  })

  it('checks the answer against the schema', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ text: 1 })))
    )
    await expect(
      fetchJson('https://llm.example/v1/x', z.object({ text: z.string() }), { label: 'The model' })
    ).rejects.toMatchObject({ message: 'The model answered in an unexpected shape' })
  })
})

describe('upstream', () => {
  it('turns failures into 502 module_unavailable and keeps route errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(
      upstream('Speech recognition is unavailable', async () => {
        throw new UpstreamError('down', 503)
      })
    ).rejects.toMatchObject({ status: 502, code: 'module_unavailable' })
    const own = new ApiError(400, 'validation', 'bad')
    await expect(
      upstream('x', async () => {
        throw own
      })
    ).rejects.toBe(own)
  })
})

describe('parseModels', () => {
  it('keeps speech and chat models in order, labelled by name', () => {
    expect(
      parseModels({
        data: [
          { id: 'jlu/whisper-1' },
          { id: 'llama', name: 'Llama 3' },
          { id: 'llama' },
          { id: ' ' }
        ]
      })
    ).toEqual([
      { id: 'jlu/whisper-1', label: 'jlu/whisper-1' },
      { id: 'llama', label: 'Llama 3' }
    ])
  })
})
