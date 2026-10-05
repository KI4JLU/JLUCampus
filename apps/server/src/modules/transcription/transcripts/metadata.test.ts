import type { TranscriptionSegment } from '@justcampus/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  fallbackTitle,
  generateSubtitle,
  generateTitle,
  isDefaultTitle,
  parseTitleAnswer,
  reportsMissingContent,
  sanitizeSubtitle,
  SUBTITLE_MAX_TOKENS,
  SUBTITLE_SYSTEM_PROMPT,
  TITLE_MAX_TOKENS,
  TITLE_PROMPTS,
  titleInput,
  titleLanguage,
  transcriptHead
} from './metadata.js'

const target = {
  baseUrl: 'https://api.hrz.example/v1',
  apiKey: 'key',
  model: 'jlu/qwen3.8-27b-fast',
  timeoutMs: 5000,
  disableThinking: true
}

function segment(
  id: number,
  speaker: string | null,
  text: string,
  redactions: TranscriptionSegment['redactions'] = []
): TranscriptionSegment {
  return { id, start: id * 5, end: id * 5 + 4, speaker, text, redactions }
}

const segments = [
  segment(0, 'Anna', ' Guten Tag. Dies ist ein kurzer Test der Transkription.'),
  segment(1, null, 'Wir treffen uns am Montag in Gießen.', [{ start: 29, end: 35 }])
]

/**
 * Answers like the HRZ gateway (LiteLLM before vLLM) did in a recorded run: `content` with the
 * answer, or `null` with the thinking in `reasoning_content` when the budget ran out first.
 */
function gateway(message: { content: string | null; reasoning_content?: string }): {
  bodies: Array<Record<string, unknown>>
} {
  const bodies: Array<Record<string, unknown>> = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-6d4256dc',
        model: 'jlu/qwen3.8-27b-fast',
        object: 'chat.completion',
        system_fingerprint: 'vllm-0.30.0',
        choices: [
          {
            finish_reason: message.content === null ? 'length' : 'stop',
            index: 0,
            message: {
              role: 'assistant',
              provider_specific_fields: { reasoning: message.reasoning_content ?? null },
              ...message
            }
          }
        ],
        usage: { completion_tokens: 10, prompt_tokens: 132, total_tokens: 142 }
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  })
  return { bodies }
}

afterEach(() => vi.restoreAllMocks())

describe('made-up titles', () => {
  it('only replaces titles the app or kiChat made up', () => {
    expect(isDefaultTitle('interview-01', 'interview-01.mp3')).toBe(true)
    expect(isDefaultTitle('interview-01.mp3', 'interview-01.mp3')).toBe(true)
    expect(isDefaultTitle('Transcript 2', null)).toBe(true)
    expect(isDefaultTitle('Gruppe 1', 'a.wav')).toBe(true)
    expect(isDefaultTitle('Upload 05.10.2026 14:30', null)).toBe(true)
    expect(isDefaultTitle('Transkription 05.10.2026', null)).toBe(true)
    expect(isDefaultTitle('Teamsitzung Oktober', 'interview-01.mp3')).toBe(false)
  })
})

describe('title', () => {
  it('sends kiChat’s name prompt in the user’s language with the first 500 characters', async () => {
    const { bodies } = gateway({ content: 'Transkriptionstest Universität Gießen' })
    expect(await generateTitle(target, segments, 'de')).toBe(
      'Transkriptionstest Universität Gießen'
    )
    expect(bodies[0]).toEqual({
      model: 'jlu/qwen3.8-27b-fast',
      stream: false,
      max_tokens: TITLE_MAX_TOKENS,
      chat_template_kwargs: { enable_thinking: false },
      messages: [
        { role: 'system', content: TITLE_PROMPTS.de },
        {
          role: 'user',
          content:
            'Guten Tag. Dies ist ein kurzer Test der Transkription. Wir treffen uns am Montag in [AUSGEBLENDET].'
        }
      ]
    })
    expect(titleLanguage('en-GB')).toBe('en')
    expect(titleLanguage(null)).toBe('de')
    const long = titleInput([segment(0, 'Anna', 'Wort '.repeat(200))])
    expect(long).toHaveLength(503)
    expect(long.endsWith('...')).toBe(true)
  })

  it('falls back to the start of the text when the model thought too long', async () => {
    gateway({ content: null, reasoning_content: 'The user wants me to assign a three-word title' })
    expect(await generateTitle(target, segments, 'en')).toBe(
      'Guten Tag. Dies ist ein kurzer Test der Transkript...'
    )
    expect(fallbackTitle([])).toBeNull()
  })

  it('reads the title past thinking, Markdown and quotes, and refuses non-titles', () => {
    expect(parseTitleAnswer('<think>\nDrei Wörter.\n</think>\n\n**„Planung Sommerfest“**')).toBe(
      'Planung Sommerfest'
    )
    expect(parseTitleAnswer('Titel: Haushalt 2027\nweiterer Text')).toBe('Haushalt 2027')
    expect(parseTitleAnswer('Kein Inhalt vorhanden')).toBeNull()
    expect(parseTitleAnswer('No content provided')).toBeNull()
    expect(parseTitleAnswer('INTERNAL ERROR: upstream')).toBeNull()
    expect(parseTitleAnswer('<think>abgebrochen')).toBeNull()
    expect(reportsMissingContent('Keine Datei angehängt')).toBe(true)
    expect(reportsMissingContent('Keine Angst vor Mathe')).toBe(false)
  })
})

describe('subtitle', () => {
  it('sends kiChat’s prompt with the first 200 tokens as speaker lines', async () => {
    const { bodies } = gateway({
      content: 'Transkriptionstest der Universität Gießen mit Terminvereinbarung'
    })
    expect(await generateSubtitle(target, segments)).toBe(
      'Transkriptionstest der Universität Gießen mit Terminvereinbarung'
    )
    expect(bodies[0]).toMatchObject({
      max_tokens: SUBTITLE_MAX_TOKENS,
      messages: [
        { role: 'system', content: SUBTITLE_SYSTEM_PROMPT },
        {
          role: 'user',
          content:
            'Worum geht es in dieser Aufnahme? Formuliere eine sachliche Unterzeile, die das Thema benennt.\n\nTRANSKRIPT-ANFANG:\n' +
            'Anna: Guten Tag. Dies ist ein kurzer Test der Transkription.\n' +
            'Unbekannt: Wir treffen uns am Montag in [AUSGEBLENDET].'
        }
      ]
    })
    const head = transcriptHead(
      Array.from({ length: 100 }, (_, id) => segment(id, 'Anna', 'Ein Satz mit Inhalt.'))
    )
    expect(head.length).toBeLessThanOrEqual(800)
  })

  it('cleans the answer as kiChat does', () => {
    expect(sanitizeSubtitle('Hier die Unterzeile:\n„Planung des Sommerfests.“')).toBe(
      'Planung des Sommerfests'
    )
    expect(sanitizeSubtitle('<think>hm</think>**Haushalt** und `Personal`!')).toBe(
      'Haushalt und Personal'
    )
    const cut = sanitizeSubtitle(`${'Besprechung der Themen '.repeat(6)}Ende`)!
    expect(cut.length).toBeLessThanOrEqual(80)
    expect(cut.endsWith('Themen')).toBe(true)
    expect(sanitizeSubtitle('x'.repeat(201))).toBeNull()
    expect(sanitizeSubtitle('')).toBeNull()
    expect(sanitizeSubtitle('INTERNAL ERROR: x')).toBeNull()
  })
})
