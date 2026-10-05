import { TRANSCRIPTION_DEFAULT_CONFIG } from '@justcampus/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { NO_SECRETS } from '../transcripts/testing.js'
import { chatTarget, complete, completionBody, parseJsonObject } from './chat.js'

afterEach(() => vi.restoreAllMocks())

/** The HRZ gateway's answer as recorded: vLLM's fields next to LiteLLM's. */
function recorded(message: Record<string, unknown>, finishReason = 'stop'): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-6d4256dc-2300-4d8c-bea7-3f4658013481',
      created: 1791197313,
      model: 'jlu/qwen3.8-27b-fast',
      object: 'chat.completion',
      system_fingerprint: 'vllm-0.30.0-c8ca3da2',
      choices: [
        {
          finish_reason: finishReason,
          index: 0,
          message: { role: 'assistant', ...message },
          provider_specific_fields: { routed_experts: null, stop_reason: null, token_ids: null }
        }
      ],
      usage: { completion_tokens: 10, prompt_tokens: 132, total_tokens: 142 }
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )
}

const target = {
  baseUrl: 'https://api.hrz.uni-giessen.de/v1',
  apiKey: 'key',
  model: 'jlu/qwen3.8-27b-fast',
  timeoutMs: 5000,
  disableThinking: true
}

describe('chat target', () => {
  it('uses the HRZ gateway and its models once the admin listed them', () => {
    const runtime = { config: TRANSCRIPTION_DEFAULT_CONFIG, secrets: NO_SECRETS }
    expect(TRANSCRIPTION_DEFAULT_CONFIG.llmBaseUrl).toBe('https://api.hrz.uni-giessen.de/v1')
    // A fresh module lists no model yet, so it sends nothing anywhere.
    expect(chatTarget(runtime, 'summary')).toBeNull()
    const listed = {
      ...runtime,
      config: {
        ...TRANSCRIPTION_DEFAULT_CONFIG,
        llmModels: [
          { id: 'jlu/gemma-4-26b-it', label: 'Gemma' },
          { id: 'jlu/qwen3.8-27b', label: 'Qwen' },
          { id: 'jlu/qwen3.8-27b-fast', label: 'Qwen fast' }
        ]
      }
    }
    expect(chatTarget(listed, 'summary')).toMatchObject({
      model: 'jlu/qwen3.8-27b',
      disableThinking: true
    })
    expect(chatTarget(listed, 'correction')?.model).toBe('jlu/qwen3.8-27b-fast')
  })
})

describe('requests', () => {
  it('sends kiChat’s parameters only where set, and the thinking switch', () => {
    const messages = [{ role: 'user' as const, content: 'x' }]
    expect(completionBody(target, messages)).toEqual({
      model: 'jlu/qwen3.8-27b-fast',
      messages,
      stream: false,
      chat_template_kwargs: { enable_thinking: false }
    })
    expect(
      completionBody({ ...target, disableThinking: false }, messages, {
        temperature: 0,
        maxTokens: 10
      })
    ).toEqual({
      model: 'jlu/qwen3.8-27b-fast',
      messages,
      stream: false,
      temperature: 0,
      max_tokens: 10
    })
  })

  it('reads the answer, not the thinking, of recorded gateway answers', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        recorded({ content: 'Transkriptionstest Universität Gießen', reasoning_content: null })
      )
      .mockResolvedValueOnce(
        recorded(
          {
            content: null,
            reasoning_content: 'The user wants me to assign a three-word title',
            provider_specific_fields: {
              reasoning: 'The user wants me to assign a three-word title'
            }
          },
          'length'
        )
      )
      .mockResolvedValueOnce(
        recorded({ content: '<think>\nIch fasse zusammen.\n</think>\n\n- Termin am 12. Juli' })
      )
    const ask = (): Promise<string> => complete(target, [{ role: 'user', content: 'x' }])
    expect(await ask()).toBe('Transkriptionstest Universität Gießen')
    expect(await ask()).toBe('')
    expect(await ask()).toBe('- Termin am 12. Juli')
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.hrz.uni-giessen.de/v1/chat/completions')
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer key')
  })

  it('finds JSON after thinking', () => {
    expect(parseJsonObject('<think>{"nein": 1}</think>\n{"ja": 2}')).toEqual({ ja: 2 })
  })
})
