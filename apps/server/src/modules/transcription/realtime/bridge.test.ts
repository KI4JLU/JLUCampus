import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { TRANSCRIPTION_API, TRANSCRIPTION_DEFAULT_CONFIG } from '@justcampus/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { json, NO_SECRETS, testApp } from '../transcripts/testing.js'
import {
  AVAILABLE_TTL_MS,
  bridgeEndpoints,
  forgetAvailability,
  gatewayBaseOf,
  onpremAvailability,
  onpremSignaling,
  onpremTarget,
  rememberAvailability,
  UNAVAILABLE_TTL_MS,
  warnIfProxied,
  type OnpremTarget
} from './bridge.js'
import { realtimeRouter } from './index.js'
import { probeOffer } from './sdp.js'

const relative = (path: string): string => path.replace('/api/modules/transcription', '')

/** A bridge answer, as `bridge.py` gives it, for an offer. */
function answerFor(offer: string): string {
  const sections = offer.split(/\r?\n(?=m=)/).slice(1)
  const transport = [
    'c=IN IP4 0.0.0.0',
    'a=ice-ufrag:abcd',
    'a=ice-pwd:abcdefghijklmnopqrstuvwx',
    `a=fingerprint:sha-256 ${Array.from({ length: 32 }, () => 'AB').join(':')}`,
    'a=setup:active'
  ]
  return [
    'v=0',
    'o=- 1 1 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    ...sections.flatMap((section, index) => [
      section.split(/\r?\n/)[0]!,
      ...transport,
      `a=mid:${index}`
    ]),
    ''
  ].join('\r\n')
}

interface Seen {
  method: string
  path: string
  headers: IncomingHttpHeaders
  body: string
}

describe('the realtime bridge proxy', () => {
  let server: Server
  let origin: string
  const seen: Seen[] = []
  /** What the fake bridge answers next, by path; default: kiChat's bridge succeeding. */
  let answers: Record<string, (body: string) => { status: number; type: string; body: string }> = {}

  beforeAll(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        const path = new URL(request.url ?? '/', 'http://bridge').pathname
        seen.push({ method: request.method ?? '', path, headers: request.headers, body })
        const answer =
          answers[path]?.(body) ??
          (path === '/realtime'
            ? { status: 200, type: 'application/sdp', body: answerFor(body) }
            : path === '/probe'
              ? { status: 200, type: 'application/json', body: '{"ok":true}' }
              : { status: 200, type: 'text/plain', body: 'ok' })
        response.writeHead(answer.status, { 'Content-Type': answer.type })
        response.end(answer.body)
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
    vi.restoreAllMocks()
  })
  beforeEach(() => {
    seen.length = 0
    answers = {}
    forgetAvailability()
  })

  const config = (): typeof TRANSCRIPTION_DEFAULT_CONFIG => ({
    ...TRANSCRIPTION_DEFAULT_CONFIG,
    asrBaseUrl: 'https://api.example.org/v1',
    realtimeModes: ['onprem'],
    onpremSignalingUrl: origin
  })
  const target = (): OnpremTarget =>
    onpremTarget(config(), { apiKey: 'sk-gateway-secret' }, 'bridge-secret-0123456789')!

  it('derives the bridge endpoints and the gateway base', () => {
    expect(bridgeEndpoints('http://host.docker.internal:8089')).toEqual({
      signaling: 'http://host.docker.internal:8089/realtime',
      probe: 'http://host.docker.internal:8089/probe',
      health: 'http://host.docker.internal:8089/health'
    })
    expect(bridgeEndpoints('https://bridge.example/rt/realtime/').signaling).toBe(
      'https://bridge.example/rt/realtime'
    )
    expect(gatewayBaseOf('https://api.hrz.uni-giessen.de/v1/')).toBe(
      'https://api.hrz.uni-giessen.de'
    )
    // Without its own gateway the path streams to the speech endpoint, its first worker.
    expect(
      onpremTarget(
        { ...config(), asrBaseUrl: 'https://a.example/v1, https://b.example/v1' },
        { apiKey: null },
        undefined
      )
    ).toMatchObject({
      gatewayUrl: 'https://a.example/v1',
      gatewayBase: 'https://a.example',
      gatewayKey: null,
      model: 'voxtral-mini-realtime',
      bridgeKey: null
    })
    expect(
      onpremTarget({ ...config(), onpremGatewayUrl: 'https://gw.example/v1' }, NO_SECRETS, 'k')
    ).toMatchObject({ gatewayBase: 'https://gw.example' })
    expect(onpremTarget({ ...config(), onpremSignalingUrl: null }, NO_SECRETS, 'k')).toBeNull()
    expect(onpremTarget({ ...config(), asrBaseUrl: null }, NO_SECRETS, 'k')).toBeNull()
  })

  it('sends the offer as SDP with the gateway headers and the bridge key, as kiChat', async () => {
    const offer = probeOffer()
    const answer = await onpremSignaling(target(), offer)
    expect(answer).toBe(answerFor(offer))
    expect(seen).toHaveLength(1)
    const [request] = seen
    expect(request).toMatchObject({ method: 'POST', path: '/realtime', body: offer })
    expect(request!.headers).toMatchObject({
      'content-type': 'application/sdp',
      'x-gateway-base': 'https://api.example.org',
      'x-gateway-key': 'sk-gateway-secret',
      'x-model': 'voxtral-mini-realtime',
      authorization: 'Bearer bridge-secret-0123456789'
    })
  })

  it('passes the answer to the browser through the route, never the gateway key', async () => {
    const app = testApp(realtimeRouter, {
      config: config(),
      secrets: { apiKey: 'sk-gateway-secret' }
    })
    const offer = probeOffer()
    const response = await app.request(
      relative(TRANSCRIPTION_API.realtimeOnpremSignaling),
      json('POST', { sdp: offer })
    )
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(JSON.parse(text)).toEqual({ sdp: answerFor(offer) })
    expect(text).not.toContain('sk-gateway-secret')
    expect(seen.at(-1)?.headers['x-gateway-key']).toBe('sk-gateway-secret')

    // A refusal by the gateway: a clear message for the browser, still without the key.
    answers['/realtime'] = () => ({
      status: 502,
      type: 'application/json',
      body: JSON.stringify({ error: 'upstream_failed', message: 'connect sk-gateway-secret' })
    })
    const failed = await app.request(
      relative(TRANSCRIPTION_API.realtimeOnpremSignaling),
      json('POST', { sdp: offer })
    )
    expect(failed.status).toBe(502)
    const failure = await failed.text()
    expect(failure).not.toContain('sk-gateway-secret')
    expect(JSON.parse(failure)).toMatchObject({
      error: { message: 'The realtime bridge cannot reach the gateway' }
    })
  })

  it('logs what the bridge says without the gateway key it may reflect (B-1)', async () => {
    const app = testApp(realtimeRouter, {
      config: config(),
      secrets: { apiKey: 'gw-reflected-key-0123' }
    })
    vi.mocked(console.error).mockClear()
    answers['/realtime'] = () => ({
      status: 502,
      type: 'application/json',
      body: JSON.stringify({
        error: 'upstream_failed',
        message: 'connect failed for X-Gateway-Key gw-reflected-key-0123'
      })
    })
    const failed = await app.request(
      relative(TRANSCRIPTION_API.realtimeOnpremSignaling),
      json('POST', { sdp: probeOffer() })
    )
    expect(failed.status).toBe(502)
    expect(await failed.text()).not.toContain('gw-reflected-key-0123')
    const logged = vi.mocked(console.error).mock.calls.flat().map(String).join(' ')
    expect(logged).toContain('connect failed')
    expect(logged).not.toContain('gw-reflected-key-0123')
  })

  it('tells a busy bridge apart (B-3)', async () => {
    answers['/realtime'] = () => ({
      status: 503,
      type: 'application/json',
      body: JSON.stringify({ error: 'busy', message: 'the bridge holds as many sessions' })
    })
    await expect(onpremSignaling(target(), probeOffer())).rejects.toMatchObject({
      reason: 'bridgeBusy'
    })
  })

  it('warns once when the bridge would be reached through the proxy (B-6)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const environment = {
      HTTP_PROXY: 'http://proxy.example:3128',
      NODE_USE_ENV_PROXY: '1',
      NO_PROXY: 'localhost,127.0.0.1,minio'
    }
    expect(warnIfProxied('http://host.docker.internal:8089', environment, [])).toBe(true)
    expect(warnIfProxied('http://host.docker.internal:8089/realtime', environment, [])).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0])).toContain('host.docker.internal:8089')
    expect(String(warn.mock.calls[0])).not.toContain('proxy.example')
    expect(
      warnIfProxied(
        'http://host.docker.internal:8089',
        { ...environment, NO_PROXY: `${environment.NO_PROXY},host.docker.internal` },
        []
      )
    ).toBe(false)
    expect(warnIfProxied('http://localhost:8089', environment, [])).toBe(false)
    warn.mockRestore()
  })

  it('tells a model the key may not use from a refused key by the model list', async () => {
    answers['/realtime'] = () => ({
      status: 502,
      type: 'application/json',
      body: JSON.stringify({ error: 'upstream_rejected', upstream_status: 403 })
    })
    const fetchModels = (response: Response): void => {
      const original = globalThis.fetch
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) =>
        String(url).endsWith('/models') ? response.clone() : original(url, init)
      )
    }
    fetchModels(Response.json({ data: [{ id: 'jlu/whisper-1' }] }))
    await expect(onpremSignaling(target(), probeOffer())).rejects.toMatchObject({
      reason: 'modelNotAllowed',
      model: 'voxtral-mini-realtime'
    })
    vi.mocked(globalThis.fetch).mockRestore()
    fetchModels(new Response('Unauthorized', { status: 401 }))
    await expect(onpremSignaling(target(), probeOffer())).rejects.toMatchObject({
      reason: 'gatewayKeyRejected'
    })
    vi.mocked(globalThis.fetch).mockRestore()
    // Listed, yet refused: the gateway refuses the session itself.
    fetchModels(Response.json({ data: [{ id: 'voxtral-mini-realtime' }] }))
    await expect(onpremSignaling(target(), probeOffer())).rejects.toMatchObject({
      reason: 'gatewayRefused'
    })
    vi.mocked(globalThis.fetch).mockRestore()

    answers['/realtime'] = () => ({ status: 401, type: 'application/json', body: '{}' })
    await expect(onpremSignaling(target(), probeOffer())).rejects.toMatchObject({
      reason: 'bridgeKeyRejected'
    })
    // A refused offer is the offer's fault: no reason, the path stays available.
    answers['/realtime'] = () => ({
      status: 400,
      type: 'application/json',
      body: JSON.stringify({ error: 'bad_offer' })
    })
    const refused = await onpremSignaling(target(), probeOffer()).catch((error: unknown) => error)
    expect(refused).toMatchObject({ status: 400 })
    expect(refused).not.toHaveProperty('reason')
  })

  it('caches the probe: a working path for minutes, a failure briefly', async () => {
    const now = Date.now()
    expect(await onpremAvailability(target(), now)).toBeNull()
    expect(seen.map((request) => request.path)).toEqual(['/probe'])
    expect(seen[0]!.headers).toMatchObject({
      'x-model': 'voxtral-mini-realtime',
      authorization: 'Bearer bridge-secret-0123456789'
    })
    expect(await onpremAvailability(target(), now + AVAILABLE_TTL_MS - 1000)).toBeNull()
    expect(seen).toHaveLength(1)

    answers['/probe'] = () => ({
      status: 502,
      type: 'application/json',
      body: JSON.stringify({ error: 'upstream_closed', message: 'HTTP 503' })
    })
    expect(await onpremAvailability(target(), now + AVAILABLE_TTL_MS + 1)).toEqual({
      reason: 'gatewayRefused',
      model: 'voxtral-mini-realtime'
    })
    expect(seen).toHaveLength(2)
    // A session that worked meanwhile counts at once.
    rememberAvailability(target(), null)
    expect(await onpremAvailability(target())).toBeNull()
    expect(seen).toHaveLength(2)
    rememberAvailability(target(), { reason: 'modelNotAllowed', model: 'voxtral-mini-realtime' })
    expect(await onpremAvailability(target())).toMatchObject({ reason: 'modelNotAllowed' })
    expect(await onpremAvailability(target(), Date.now() + UNAVAILABLE_TTL_MS + 1)).toEqual({
      reason: 'gatewayRefused',
      model: 'voxtral-mini-realtime'
    })
  })
})
