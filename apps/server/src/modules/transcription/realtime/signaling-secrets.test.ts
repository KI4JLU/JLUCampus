import { TRANSCRIPTION_DEFAULT_CONFIG } from '@justcampus/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { forgetKeys, rememberKey, type UpstreamError } from '../http.js'
import { onpremSignaling, onpremTarget } from './bridge.js'
import { probeOffer } from './sdp.js'

// A problem that quotes the whole answer, as one did before E-1: the request's own keys must be
// masked in it all the same, however short and however long ago they were noted.
vi.mock('./sdp.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sdp.js')>()),
  sdpAnswerProblem: (sdp: string) => `quoted: ${sdp}`
}))

afterEach(() => {
  vi.unstubAllGlobals()
  forgetKeys()
})

describe('errors about a signaling answer', () => {
  it('mask the request’s keys even where the detail quotes the answer (E-1)', async () => {
    const long = 'opaque-gateway-credential-0123456789'
    for (const [key, bridgeKey, evict] of [
      ['review7', 'brk1234', 0],
      [long, 'bridge-credential-abcdefghijklmnop', 65]
    ] as const) {
      forgetKeys()
      vi.stubGlobal('fetch', async () => {
        for (let other = 0; other < evict; other++) rememberKey(`other-request-key-${other}-xyz`)
        const sdp = `v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=${bridgeKey}\r\nt=0 0\r\nm=${key}\r\n`
        return new Response(sdp, { status: 200, headers: { 'Content-Type': 'application/sdp' } })
      })
      const target = onpremTarget(
        {
          ...TRANSCRIPTION_DEFAULT_CONFIG,
          asrBaseUrl: 'https://api.example.org/v1',
          realtimeModes: ['onprem'],
          onpremSignalingUrl: 'http://127.0.0.1:9'
        },
        { apiKey: key },
        bridgeKey
      )!
      const error = (await onpremSignaling(target, probeOffer()).catch(
        (caught: unknown) => caught
      )) as UpstreamError
      expect(error.kind).toBe('invalidAnswer')
      expect(error.detail).toContain('quoted: v=0')
      expect(error.detail).not.toContain(key)
      expect(error.detail).not.toContain(bridgeKey)
    }
  })
})
