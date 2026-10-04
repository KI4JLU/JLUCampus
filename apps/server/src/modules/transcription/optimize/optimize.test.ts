import { TRANSCRIPTION_API, type TranscriptionSegment } from '@justcampus/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  json,
  mockChatConfig,
  startUpstreamMock,
  testApp,
  type RunningMock
} from '../transcripts/testing.js'
import { optimizeRouter } from './index.js'
import { applyAssignments, optimizationInput, parseAssignments } from './speakers.js'

vi.mock('../transcripts/store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../transcripts/store.js')>()),
  findTranscript: async (_componentId: string, userId: string, id: string) =>
    userId === 'alice' && id === transcriptId ? { id } : null
}))

const transcriptId = '11111111-1111-4111-8111-111111111111'
const path = TRANSCRIPTION_API.speakerOptimization.replace('/api/modules/transcription', '')

const segments: TranscriptionSegment[] = [
  {
    id: 1,
    start: 0,
    end: 4.123,
    text: 'Wie war dein Wochenende?',
    speaker: 'Anna',
    redactions: [],
    avgLogprob: -0.2,
    tokens: [1, 2, 3]
  },
  {
    id: 2,
    start: 4.2,
    end: 8,
    text: 'Gut, ich war in Gießen.',
    speaker: null,
    redactions: [{ start: 16, end: 22 }],
    words: [{ start: 4.2, end: 4.5, word: 'Gut' }]
  },
  { id: 3, start: 8, end: 9, text: 'Schön.', speaker: 'Ben', redactions: [] }
]

describe('assignments', () => {
  it('reads every answer shape and only takes known speakers, in any case', () => {
    const speakers = ['Anna', 'Ben']
    expect([
      ...parseAssignments(
        '{"segments": [{"id": 1, "speaker": "ben"}, {"id": "2", "speaker": "Eve"}]}',
        speakers
      )
    ]).toEqual([[1, 'Ben']])
    expect([...parseAssignments('```json\n[{"id": 3, "speaker": "Anna"}]\n```', speakers)]).toEqual(
      [[3, 'Anna']]
    )
    expect([...parseAssignments('{"1": "Anna", "x": "Ben"}', speakers)]).toEqual([[1, 'Anna']])
    expect([...parseAssignments('keine Ahnung', speakers)]).toEqual([])
  })

  it('changes nothing but the speaker', () => {
    const changed = applyAssignments(segments, new Map([[2, 'Ben']]))
    expect(changed[0]).toBe(segments[0])
    expect(changed[1]).toEqual({ ...segments[1], speaker: 'Ben' })
  })

  it('shows the model no redacted text and no decoder fields', () => {
    const input = JSON.parse(optimizationInput(segments, ['Anna', 'Ben'])) as {
      segments: Array<Record<string, unknown>>
    }
    expect(input.segments[1]).toEqual({
      id: 2,
      start: 4.2,
      end: 8,
      speaker: null,
      text: 'Gut, ich war in [AUSGEBLENDET].'
    })
    expect(input.segments[0]).not.toHaveProperty('tokens')
  })
})

describe('speaker optimisation route', () => {
  let mock: RunningMock
  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mock = await startUpstreamMock()
  })
  afterAll(async () => {
    await mock.close()
    vi.restoreAllMocks()
  })

  it('reassigns speakers and keeps text, timing, redactions and decoder fields', async () => {
    const app = testApp(optimizeRouter, { config: mockChatConfig(mock.origin) })
    const response = await app.request(path, json('POST', { segments, transcriptId }))
    expect(response.status).toBe(200)
    const body = (await response.json()) as { segments: TranscriptionSegment[] }
    expect(body.segments.map((segment) => segment.speaker)).toEqual(['Anna', 'Anna', 'Ben'])
    const unnamed = (segment: TranscriptionSegment): TranscriptionSegment => ({
      ...segment,
      speaker: null
    })
    expect(body.segments.map(unnamed)).toEqual(segments.map(unnamed))
  })

  it('leaves a single speaker alone without asking the model', async () => {
    const app = testApp(optimizeRouter)
    const single = segments.map((segment) => ({ ...segment, speaker: 'Anna' }))
    const unavailable = await app.request(path, json('POST', { segments: single }))
    expect(unavailable.status).toBe(502)
    const response = await testApp(optimizeRouter, { config: mockChatConfig(mock.origin) }).request(
      path,
      json('POST', { segments: single })
    )
    expect(await response.json()).toEqual({ segments: single })
  })

  it('refuses another user’s transcript, empty input and a failing model', async () => {
    const config = mockChatConfig(mock.origin)
    const bob = testApp(optimizeRouter, { userId: 'bob', config })
    expect((await bob.request(path, json('POST', { segments, transcriptId }))).status).toBe(404)
    const app = testApp(optimizeRouter, { config })
    expect((await app.request(path, json('POST', { segments: [] }))).status).toBe(400)
    const failing = await app.request(path, json('POST', { segments, model: 'mock-fail' }))
    expect(failing.status).toBe(502)
    expect(await failing.json()).toMatchObject({ error: { code: 'module_unavailable' } })
  })
})
