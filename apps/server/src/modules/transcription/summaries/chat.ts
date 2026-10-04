import { z } from 'zod'

import { ApiError } from '../../../api.js'
import { llmModel, type TranscriptionRuntime } from '../config.js'
import { bearer, ensureOk, readJson, upstreamFetch, upstreamUrl } from '../http.js'

/**
 * The OpenAI-compatible chat endpoint that writes summaries, section previews, subtitles and
 * speaker optimisations. Prompts ask for JSON, which is parsed leniently as in the translator: past
 * thinking blocks and code fences, falling back to the raw answer where that still makes sense.
 */

export interface ChatTarget {
  baseUrl: string
  apiKey: string | null
  model: string
  timeoutMs: number
}

/**
 * The chat endpoint and model for a purpose, `requested` only if the admin listed it; `null` while
 * no chat endpoint or model is set up.
 */
export function chatTarget(
  runtime: Pick<TranscriptionRuntime, 'config' | 'secrets'>,
  purpose: 'correction' | 'summary',
  requested: string | null = null
): ChatTarget | null {
  const { config, secrets } = runtime
  const model = llmModel(config, purpose, requested)
  if (!config.llmBaseUrl || !model) return null
  return {
    baseUrl: config.llmBaseUrl,
    apiKey: secrets.llmApiKey,
    model,
    timeoutMs: config.upstreamTimeoutSeconds * 1000
  }
}

/** `chatTarget`, or `502 module_unavailable` for a route while none is set up. */
export function requireChatTarget(
  runtime: Pick<TranscriptionRuntime, 'config' | 'secrets'>,
  purpose: 'correction' | 'summary',
  requested: string | null = null
): ChatTarget {
  const target = chatTarget(runtime, purpose, requested)
  if (!target) throw new ApiError(502, 'module_unavailable', 'No chat model is set up')
  return target
}

const chatCompletionSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullable().optional() }) }))
    .min(1)
})

export interface ChatMessage {
  role: 'system' | 'user'
  content: string
}

/** One chat completion; its text, or an `UpstreamError`. */
export async function complete(
  target: ChatTarget,
  messages: readonly ChatMessage[],
  options: { temperature?: number; signal?: AbortSignal } = {}
): Promise<string> {
  const response = await ensureOk(
    await upstreamFetch(upstreamUrl(target.baseUrl, 'chat/completions'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...bearer(target.apiKey)
      },
      body: JSON.stringify({
        model: target.model,
        messages,
        temperature: options.temperature ?? 0.2,
        stream: false
      }),
      timeoutMs: target.timeoutMs,
      signal: options.signal
    }),
    'The chat model'
  )
  const completion = await readJson(response, chatCompletionSchema, 'The chat model')
  return completion.choices[0]!.message.content ?? ''
}

/** The answer without thinking blocks and with code fences unwrapped. */
export function stripModelFormatting(content: string): string {
  return content
    .replace(/<think>[^]*?<\/think>/gi, '')
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
  const withoutThinking = content.replace(/<think>[^]*?<\/think>/gi, '').trim()
  const cleaned = stripModelFormatting(content)
  for (const candidate of [
    withoutThinking,
    cleaned,
    firstJsonObject(withoutThinking),
    firstJsonObject(cleaned)
  ]) {
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
  const withoutThinking = content.replace(/<think>[^]*?<\/think>/gi, '').trim()
  const fenced = /^```(?:markdown|md)?\s*\n([^]*?)\n```$/i.exec(withoutThinking)
  return (fenced ? fenced[1]! : withoutThinking).trim()
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
