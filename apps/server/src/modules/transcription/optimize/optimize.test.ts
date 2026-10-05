import { TRANSCRIPTION_API, type TranscriptionSegment } from '@justcampus/shared'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  json,
  mockChatConfig,
  startUpstreamMock,
  testApp,
  type RunningMock
} from '../transcripts/testing.js'
import { optimizeRouter } from './index.js'
import {
  applyAssignments,
  buildOptimizationPrompt,
  formatSegments,
  mergeSpeakerRuns,
  OPTIMIZATION_SYSTEM_PROMPT,
  optimizeSpeakers,
  optimizeTranscriptSpeakers,
  parseCorrections,
  restructureBatch,
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
    const prompt = buildOptimizationPrompt(listed)
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
    expect(messages[0]).toEqual({ role: 'system', content: OPTIMIZATION_SYSTEM_PROMPT })
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

describe('restructuring (after recognition)', () => {
  afterEach(() => vi.restoreAllMocks())

  const long: TranscriptionSegment[] = [
    {
      id: 4,
      start: 10,
      end: 14,
      text: ' Ich habe mir die Zahlen angeschaut. Oh Mann! Aber wir warten.',
      speaker: 'Anna',
      redactions: [],
      tokens: [7, 8],
      avgLogprob: -0.1,
      words: [
        { start: 10, end: 11, word: 'Ich' },
        { start: 12.4, end: 12.6, word: 'Oh' },
        { start: 13.5, end: 13.9, word: 'warten' }
      ]
    },
    { id: 9, start: 14.5, end: 16, text: 'Das passt so.', speaker: 'Ben', redactions: [] }
  ]

  it('splits by text length, assigns words by their middle, strips labels and merges', async () => {
    answerWith(
      JSON.stringify([
        { original_index: 0, text: 'Ich habe mir die Zahlen angeschaut.', speaker: 'Anna' },
        { original_index: 0, text: 'Ben: Oh Mann!', speaker: 'Ben' },
        { original_index: 0, text: 'Aber wir warten.', speaker: 'Anna' },
        { original_index: 1, text: 'Das passt so.', speaker: 'Anna' }
      ])
    )
    const result = await optimizeTranscriptSpeakers(target, long)
    expect(result.map(({ id, speaker, text }) => ({ id, speaker, text }))).toEqual([
      { id: 4, speaker: 'Anna', text: 'Ich habe mir die Zahlen angeschaut.' },
      { id: 10, speaker: 'Ben', text: 'Oh Mann!' },
      { id: 11, speaker: 'Anna', text: 'Aber wir warten. Das passt so.' }
    ])
    // 35 + 8 + 16 characters over four seconds.
    expect(result[0]).toMatchObject({ start: 10, end: 12.37, avgLogprob: -0.1 })
    expect(result[0]).not.toHaveProperty('tokens')
    expect(result[0]!.words!.map((word) => word.word)).toEqual(['Ich'])
    expect(result[1]!.words!.map((word) => word.word)).toEqual(['Oh'])
    expect(result[2]).toMatchObject({ start: 12.92, end: 16 })
  })

  it('keeps redacted text, untrusted rewrites and segments the model left out', () => {
    const grouped = new Map([
      [
        0,
        [{ text: 'Ein ganz anderer Text, viel länger als das Original davor.', resolved: 'Ben' }]
      ],
      [1, [{ text: 'Gut, ich war in Berlin.', resolved: 'Ben' }]]
    ])
    let next = 100
    const result = restructureBatch(segments, grouped, ['Anna', 'Ben'], () => next++)
    expect(result[0]).toEqual({ ...segments[0], speaker: 'Ben' })
    expect(result[1]).toEqual({ ...segments[1], speaker: 'Ben' })
    expect(result[2]).toBe(segments[2])
    expect(
      restructureBatch(
        long.slice(0, 1),
        new Map([[0, [{ text: 'Ja.', resolved: 'Ben' }]]]),
        ['Anna', 'Ben'],
        () => next++
      )[0]
    ).toEqual({ ...long[0], speaker: 'Ben' })
  })

  it('does not merge redacted segments', () => {
    const redacted = { ...segments[1]!, speaker: 'Anna', start: 4.2 }
    expect(mergeSpeakerRuns([segments[0]!, redacted])).toHaveLength(2)
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
