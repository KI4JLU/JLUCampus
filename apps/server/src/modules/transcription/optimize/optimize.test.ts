import { TRANSCRIPTION_API, type TranscriptionSegment } from '@justcampus/shared'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  json,
  mockChatConfig,
  startUpstreamMock,
  testApp,
  type RunningMock
} from '../transcripts/testing.js'
import { CORRECTION_SYSTEM_PROMPT, correctionPrompt } from '../jobs/correction.js'
import { optimizeRouter } from './index.js'
import {
  applyAssignments,
  formatSegments,
  optimizeSpeakers,
  parseCorrections,
  speakerAssignments,
  UnusableOptimizationError
} from './speakers.js'

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

const target = {
  baseUrl: 'https://llm.example/v1',
  apiKey: null,
  model: 'm',
  timeoutMs: 5000,
  disableThinking: true
}

/** Answers every chat request with `content`, as vLLM behind LiteLLM does; the bodies sent. */
function answerWith(...contents: string[]): { bodies: Array<Record<string, unknown>> } {
  const bodies: Array<Record<string, unknown>> = []
  let call = 0
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    const content = contents[Math.min(call++, contents.length - 1)]
    return new Response(
      JSON.stringify({
        model: 'jlu/qwen3.8-27b-fast',
        choices: [
          {
            finish_reason: 'stop',
            message: { role: 'assistant', content, reasoning_content: null }
          }
        ]
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  })
  return { bodies }
}

describe('kiChat’s prompt', () => {
  it('lists the segments as kiChat does, redacted, and asks for the JSON array', () => {
    const listed = formatSegments(segments)
    expect(listed).toBe(
      'Segment [0] (Anna): Wie war dein Wochenende?\n' +
        'Segment [1] (Unbekannt): Gut, ich war in [AUSGEBLENDET].\n' +
        'Segment [2] (Ben): Schön.\n'
    )
    const prompt = correctionPrompt(listed)
    expect(prompt).toContain('Hier ist das Transkript:\n' + listed + '\n')
    expect(prompt).toContain('"original_index"')
    expect(prompt.endsWith('kein Markdown-Fencing (kein ```json).')).toBe(true)
  })

  it('reads the array past thinking, fences, prose and wrapping objects', () => {
    const entry = { original_index: 1, text: 'Gut.', speaker: 'Ben' }
    for (const content of [
      JSON.stringify([entry]),
      `<think>Segment 1 ist die Antwort auf die Frage.</think>\n\n\`\`\`json\n${JSON.stringify([entry])}\n\`\`\``,
      `Hier ist das Ergebnis:\n${JSON.stringify([entry])}\nFertig.`,
      JSON.stringify({ segments: [{ ...entry, original_index: '1' }] })
    ]) {
      expect(parseCorrections(content)).toEqual([
        { originalIndex: 1, text: 'Gut.', speaker: 'Ben' }
      ])
    }
    expect(parseCorrections('keine Ahnung')).toEqual([])
    expect(parseCorrections('[{"original_index": -1, "speaker": "Ben"}, {"text": "x"}]')).toEqual(
      []
    )
  })
})

describe('speakers only (the route)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('takes the speaker of most of each segment’s text and nothing else', async () => {
    const { bodies } = answerWith(
      '<think>\nAnna fragt, Ben antwortet.\n</think>\n[' +
        '{"original_index": 0, "text": "Wie war dein Wochenende?", "speaker": "Anna"},' +
        '{"original_index": 1, "text": "Gut,", "speaker": "Anna"},' +
        '{"original_index": 1, "text": "ich war in [AUSGEBLENDET].", "speaker": "ben"},' +
        '{"original_index": 2, "text": "Schön.", "speaker": "Eve"}]'
    )
    const optimized = await optimizeSpeakers(target, segments)
    expect(optimized.map((segment) => segment.speaker)).toEqual(['Anna', 'Ben', 'Ben'])
    expect(optimized[0]).toBe(segments[0])
    expect(optimized[1]).toEqual({ ...segments[1], speaker: 'Ben' })
    expect(bodies[0]).toMatchObject({
      model: 'm',
      stream: false,
      chat_template_kwargs: { enable_thinking: false }
    })
    expect(bodies[0]).not.toHaveProperty('temperature')
    const messages = bodies[0]!.messages as Array<{ role: string; content: string }>
    expect(messages[0]).toEqual({ role: 'system', content: CORRECTION_SYSTEM_PROMPT })
  })

  it('lets Unbekannt take no name away', () => {
    const grouped = new Map([[0, [{ text: 'Wie war dein Wochenende?', resolved: null }]]])
    expect(speakerAssignments(segments.slice(0, 1), grouped)).toEqual(new Map([[1, 'Anna']]))
  })

  it('fails a batch the model answered without a usable assignment', async () => {
    for (const content of [
      'I cannot provide an assignment',
      '[{"original_index": 99, "text": "x", "speaker": "Anna"}]',
      '[{"original_index": 0, "text": "x", "speaker": "Eve"}]'
    ]) {
      answerWith(content)
      await expect(optimizeSpeakers(target, segments)).rejects.toBeInstanceOf(
        UnusableOptimizationError
      )
      vi.restoreAllMocks()
    }
  })

  it('changes nothing but the speaker', () => {
    const changed = applyAssignments(segments, new Map([[2, 'Ben']]))
    expect(changed[0]).toBe(segments[0])
    expect(changed[1]).toEqual({ ...segments[1], speaker: 'Ben' })
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

  it('reports an answer without a usable assignment as an error, not as a success', async () => {
    const app = testApp(optimizeRouter, { config: mockChatConfig(mock.origin) })
    const response = await app.request(
      path,
      json('POST', { segments, transcriptId, model: 'mock-prose' })
    )
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: { code: 'module_unavailable' } })
  })
})
