import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { ApiError } from '../../api.js'
import {
  bearer,
  DETAIL_MAX,
  ensureOk,
  fetchJson,
  forgetKeys,
  maskSecrets,
  parseModels,
  secretsOf,
  upstream,
  UpstreamError,
  upstreamFetch,
  upstreamUrl
} from './http.js'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  forgetKeys()
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

describe('keys reflected by an upstream (B-1)', () => {
  // No `sk-` key: only the key the request sent tells it apart from text.
  const sentinel = 'gw-sentinel-4f1d9c2e7b'

  it('masks given, sent and key-like strings', () => {
    expect(maskSecrets('key=abc123def', ['abc123def'])).toBe('key=***')
    expect(maskSecrets('Authorization: Bearer abc.def-ghi, next')).toBe(
      'Authorization: Bearer ***, next'
    )
    expect(maskSecrets('{"api_key": "plain-value-123"}')).toBe('{"api_key": "***"}')
    expect(maskSecrets('token sk-live-abcdefgh')).toBe('token sk-***')
    bearer('custom-gateway-key-9876')
    expect(maskSecrets('refused custom-gateway-key-9876')).toBe('refused ***')
  })

  it('never keeps a key a refusing upstream repeats in an error, nor logs it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { message: `Received API key ${sentinel} is invalid` } }),
            { status: 403 }
          )
      )
    )
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const run = async (): Promise<unknown> => {
      const response = await upstreamFetch('https://gw.example/v1/audio/transcriptions', {
        headers: bearer(sentinel)
      })
      return ensureOk(response, 'The speech server')
    }
    const error = await run().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(UpstreamError)
    const { detail, message, stack } = error as UpstreamError
    for (const text of [detail, message, stack]) expect(text).not.toContain('sentinel-4f1d9c2e7b')
    await expect(upstream('Speech recognition is unavailable', run)).rejects.toMatchObject({
      status: 502
    })
    expect(JSON.stringify(logged.mock.calls, Object.getOwnPropertyNames(error))).not.toContain(
      'sentinel-4f1d9c2e7b'
    )
    expect(String(logged.mock.calls)).not.toContain('sentinel-4f1d9c2e7b')
  })
})

describe('masking whatever the key (C-1)', () => {
  const refusing = (body: string): void => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 403 }))
    )
  }
  const failure = async (
    headers: Record<string, string>,
    secrets: string[] = []
  ): Promise<UpstreamError> => {
    const response = await upstreamFetch('https://gw.example/v1/models', { headers, secrets })
    return ensureOk(response, 'The gateway').then(
      () => {
        throw new Error('no failure')
      },
      (error: unknown) => error as UpstreamError
    )
  }

  it('masks a short key of the request, also without a note of it', async () => {
    refusing('Rejected credential review7')
    forgetKeys()
    const error = await failure({ Authorization: 'Bearer review7' })
    expect(error.detail).toBe('Rejected credential ***')
    // Even one character: the request's own key is masked whatever its length.
    refusing('key x refused')
    expect((await failure({ Authorization: 'Bearer x' })).detail).not.toMatch(/\bx\b/)
    bearer('review7')
    await expect(
      ensureOk(new Response('Rejected credential review7', { status: 403 }), 'gateway')
    ).rejects.toMatchObject({ detail: 'Rejected credential ***' })
  })

  it('masks the whole body before cutting it short', async () => {
    const key = 'opaque-review-credential-0123456789'
    refusing(`${'x'.repeat(485)}${key}`)
    const error = await failure({ Authorization: `Bearer ${key}` })
    expect(error.detail).toBe(`${'x'.repeat(485)}***`)
    expect(error.detail).not.toContain('opaque')
    refusing(`${'y'.repeat(498)}${key}`)
    const cut = await failure({ Authorization: `Bearer ${key}` })
    expect(cut.detail).toHaveLength(DETAIL_MAX)
    expect(cut.detail).not.toMatch(/op$|o$/)
  })

  it('masks a longer key before a shorter one inside it', async () => {
    bearer('review-prefix-key')
    refusing('refused review-prefix-key-new-secret')
    const error = await failure(bearer('review-prefix-key-new-secret'))
    expect(error.detail).toBe('refused ***')
    expect(maskSecrets('a review-prefix-key-new-secret b')).toBe('a *** b')
  })

  it('keeps an in-flight key masked after the note of it is gone', async () => {
    const key = 'in-flight-opaque-credential'
    let answer: (response: Response) => void = () => {}
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => (answer = resolve)))
    )
    const pending = upstreamFetch('https://gw.example/v1/models', { headers: bearer(key) })
    // Other requests push the key out of the note of keys sent lately meanwhile.
    for (let index = 0; index < 100; index += 1) bearer(`another-key-of-the-form-${index}`)
    expect(maskSecrets(key)).toBe(key)
    answer(new Response(`bad ${key}`, { status: 403 }))
    const error = await ensureOk(await pending, 'The gateway').catch((caught: unknown) => caught)
    expect((error as UpstreamError).detail).toBe('bad ***')
  })

  it('masks gateway keys in their own headers, given secrets, and escaped spellings', async () => {
    refusing('{"error":"X-Gateway-Key gw\\"odd\\\\key is invalid"}')
    const error = await failure({ 'X-Gateway-Key': 'gw"odd\\key' })
    expect(error.detail).not.toContain('odd')
    refusing('no access for body-secret-1')
    expect((await failure({}, ['body-secret-1'])).detail).toBe('no access for ***')
    expect(secretsOf({ Authorization: 'Bearer abc', Accept: 'json' })).toEqual([
      'Bearer abc',
      'abc'
    ])
    expect(maskSecrets('see a%2Fb%3Dc', ['a/b=c'])).toBe('see ***')
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
