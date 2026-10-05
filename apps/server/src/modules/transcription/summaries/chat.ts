import { z } from 'zod'

import { ApiError } from '../../../api.js'
import { llmModel, type TranscriptionRuntime } from '../config.js'
import { bearer, ensureOk, readJson, upstreamFetch, upstreamUrl } from '../http.js'

/**
 * The OpenAI-compatible chat endpoint (the HRZ gateway by default) that writes titles, subtitles,
 * summaries, section previews and speaker optimisations with kiChat's prompts. Answers are read
 * leniently: past thinking blocks (Qwen3 models reason before they answer) and code fences.
 */

export interface ChatTarget {
  baseUrl: string
  apiKey: string | null
  model: string
  timeoutMs: number
  /** Asks vLLM to skip the model's thinking (`llmDisableThinking`). */
  disableThinking: boolean
}

/** Which default model a task uses: `correction` for the quick tasks, `summary` for summaries. */
export type ChatPurpose = 'correction' | 'summary'

/**
 * The chat endpoint and model for a purpose, `requested` only if the admin listed it; `null` while
 * no chat endpoint or model is set up.
 */
export function chatTarget(
  runtime: Pick<TranscriptionRuntime, 'config' | 'secrets'>,
  purpose: ChatPurpose,
  requested: string | null = null
): ChatTarget | null {
  const { config, secrets } = runtime
  const model = llmModel(config, purpose, requested)
  if (!config.llmBaseUrl || !model) return null
  return {
    baseUrl: config.llmBaseUrl,
    apiKey: secrets.llmApiKey,
    model,
    timeoutMs: config.upstreamTimeoutSeconds * 1000,
    disableThinking: config.llmDisableThinking
  }
}

/** `chatTarget`, or `502 module_unavailable` for a route while none is set up. */
export function requireChatTarget(
  runtime: Pick<TranscriptionRuntime, 'config' | 'secrets'>,
  purpose: ChatPurpose,
  requested: string | null = null
): ChatTarget {
  const target = chatTarget(runtime, purpose, requested)
  if (!target) throw new ApiError(502, 'module_unavailable', 'No chat model is set up')
  return target
}

/**
 * A completion. vLLM's reasoning parser puts the thinking into `reasoning_content` and leaves
 * `content` `null` when the token budget ran out while thinking; other servers keep it inline as
 * `<think>…</think>`.
 */
const chatCompletionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable().optional() }),
        finish_reason: z.string().nullable().optional()
      })
    )
    .min(1)
})

export interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

export interface ChatOptions {
  /** Left out as kiChat does, so the endpoint's default applies. */
  temperature?: number
  /** kiChat's budgets for title and subtitle; left out elsewhere. */
  maxTokens?: number
  signal?: AbortSignal
}

/** The request body of one completion, without streaming, as kiChat's `AiService` sends it. */
export function completionBody(
  target: Pick<ChatTarget, 'model' | 'disableThinking'>,
  messages: readonly ChatMessage[],
  options: Pick<ChatOptions, 'temperature' | 'maxTokens'> = {}
): Record<string, unknown> {
  return {
    model: target.model,
    messages,
    stream: false,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
    ...(target.disableThinking ? { chat_template_kwargs: { enable_thinking: false } } : {})
  }
}

/** One chat completion; its text without thinking, or an `UpstreamError`. */
export async function complete(
  target: ChatTarget,
  messages: readonly ChatMessage[],
  options: ChatOptions = {}
): Promise<string> {
  const response = await ensureOk(
    await upstreamFetch(upstreamUrl(target.baseUrl, 'chat/completions'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...bearer(target.apiKey)
      },
      body: JSON.stringify(completionBody(target, messages, options)),
      timeoutMs: target.timeoutMs,
      signal: options.signal
    }),
    'The chat model'
  )
  const completion = await readJson(response, chatCompletionSchema, 'The chat model')
  return withoutThinking(completion.choices[0]!.message.content ?? '')
}

/**
 * The answer without the model's thinking: whole `<think>…</think>` blocks, everything before a
 * lone `</think>` (templates that open the block in the prompt) and an unclosed `<think>` to the
 * end (the budget ran out while thinking).
 */
export function withoutThinking(content: string): string {
  let text = content.replace(/<think>[^]*?<\/think>/gi, '')
  const closing = text.toLowerCase().lastIndexOf('</think>')
  if (closing >= 0) text = text.slice(closing + '</think>'.length)
  const opening = text.toLowerCase().indexOf('<think>')
  if (opening >= 0) text = text.slice(0, opening)
  return text.trim()
}

/** The answer without thinking blocks and with code fences unwrapped. */
export function stripModelFormatting(content: string): string {
  return withoutThinking(content)
    .replace(/```(?:json)?\s*([^]*?)```/gi, '$1')
    .trim()
}

/** The first balanced `{…}` of a text, ignoring braces inside strings. */
function firstJsonObject(content: string): string | null {
  const start = content.indexOf('{')
  if (start < 0) return null
  let quoted = false
  let escaped = false
  let depth = 0
  for (let index = start; index < content.length; index += 1) {
    const character = content[index]!
    if (quoted) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quoted = false
      continue
    }
    if (character === '"') quoted = true
    else if (character === '{') depth += 1
    else if (character === '}' && --depth === 0) return content.slice(start, index + 1)
  }
  return null
}

/** The first JSON object in a model's answer, past thinking and code fences; `null` if none. */
export function parseJsonObject(content: string): Record<string, unknown> | null {
  const answer = withoutThinking(content)
  const cleaned = stripModelFormatting(content)
  for (const candidate of [answer, cleaned, firstJsonObject(answer), firstJsonObject(cleaned)]) {
    if (candidate === null) continue
    try {
      const value: unknown = JSON.parse(candidate)
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        return value as Record<string, unknown>
      }
    } catch {
      // Try the next representation.
    }
  }
  return null
}

/**
 * Markdown the model wrote: `{"markdown": "…"}` as asked, else the answer itself with a fence
 * around all of it unwrapped, so nothing the model said gets lost.
 */
export function parseMarkdownAnswer(content: string): string {
  const value = parseJsonObject(content)?.markdown
  if (typeof value === 'string') return value.trim()
  const answer = withoutThinking(content)
  const fenced = /^```(?:markdown|md)?\s*\n([^]*?)\n```$/i.exec(answer)
  return (fenced ? fenced[1]! : answer).trim()
}

/** Runs `run` over `items` with at most `limit` at once, keeping their order. */
export async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++
      results[index] = await run(items[index]!, index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
