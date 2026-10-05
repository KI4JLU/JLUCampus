import {
  fillTemplatePlaceholders,
  TRANSCRIPTION_REDACTED_TEXT,
  type TranscriptionTemplateBlock
} from '@justcampus/shared'
import { createHash } from 'node:crypto'

import type { PlaceholderValues } from '../transcripts/text.js'
import {
  complete,
  mapLimited,
  parseMarkdownAnswer,
  type ChatMessage,
  type ChatTarget
} from './chat.js'

/**
 * Summaries by template (T-48 to T-53), as kiChat's `TranscriptionController::summarize` writes
 * them: static blocks (headings, text, dividers) are rendered by the server with their
 * placeholders filled; each AI section is one request to the chat model with kiChat's prompt, its
 * instruction followed by the transcript, answered as Markdown. Section previews of the template
 * editor use the same request on kiChat's reduced sample of the transcript.
 */

/** Raised whenever prompts change, so stored summaries made with older ones are not reused. */
export const PROMPT_VERSION = 2

/** Tokens of kiChat's reduced sample a section preview reads (`getReducedTranscriptSample`). */
export const PREVIEW_SAMPLE_TOKENS = 2000

/** AI sections generated at once for one request. */
const SECTION_CONCURRENCY = 3

export interface SectionRequest {
  id: string
  heading: string
  instruction: string
}

/** kiChat's system prompt of every summary section. */
export const SUMMARY_SYSTEM_PROMPT =
  'Du bist ein hilfreicher Assistent, der Transkripte präzise und professionell zusammenfasst.'

/**
 * Added for Campus only when the transcript has redacted passages, which kiChat's server never
 * sees: the model is not to guess them.
 */
const REDACTION_RULE = `Stellen, die als ${TRANSCRIPTION_REDACTED_TEXT} markiert sind, wurden bewusst ausgeblendet: ergänze oder errate sie nicht.`

/**
 * The messages of one AI section: kiChat's system prompt, and its instruction (placeholders
 * filled, which kiChat leaves to the template) followed by `TRANSKRIPT:` and the transcript.
 */
export function sectionMessages(
  section: Pick<SectionRequest, 'instruction'>,
  transcript: string,
  values: PlaceholderValues
): ChatMessage[] {
  const instruction = fillTemplatePlaceholders(section.instruction, values)
  const system = transcript.includes(TRANSCRIPTION_REDACTED_TEXT)
    ? `${SUMMARY_SYSTEM_PROMPT} ${REDACTION_RULE}`
    : SUMMARY_SYSTEM_PROMPT
  return [
    { role: 'system', content: system },
    { role: 'user', content: `${instruction}\n\nTRANSKRIPT:\n${transcript}` }
  ]
}

/**
 * kiChat's excerpt for previews: lines from the beginning, around the middle and from the end,
 * each part up to a third of `maxTokens` (four characters a token), joined by an
 * `... [Ausschnitt] ...` line. Short transcripts come back whole.
 */
export function reducedTranscriptSample(
  lines: readonly string[],
  maxTokens: number = PREVIEW_SAMPLE_TOKENS
): string {
  if (lines.length === 0) return ''
  const budget = Math.floor((maxTokens * 4) / 3)
  const line = (index: number): string => `${lines[index]}\n`

  let beginning = ''
  let first = 0
  while (first < lines.length && beginning.length < budget) beginning += line(first++)

  let ending = ''
  let last = lines.length - 1
  while (last >= first && ending.length < budget) ending = line(last--) + ending

  let middle = ''
  if (last > first) {
    const center = Math.floor((first + last) / 2)
    middle = line(center)
    let left = center - 1
    let right = center + 1
    while (middle.length < budget && (left >= first || right <= last)) {
      if (left >= first) middle = line(left--) + middle
      if (middle.length < budget && right <= last) middle += line(right++)
    }
  }
  return [beginning, middle, ending].filter(Boolean).join('\n... [Ausschnitt] ...\n\n')
}

/** Drops a leading heading that only repeats the section's own. */
export function withoutRepeatedHeading(markdown: string, heading: string): string {
  if (!heading.trim()) return markdown
  const match = /^#{1,6}\s+(.+?)\s*#*\s*(?:\n+|$)/.exec(markdown)
  if (!match) return markdown
  const normalise = (text: string): string =>
    text
      .replace(/[*_`:]/g, '')
      .trim()
      .toLowerCase()
  return normalise(match[1]!) === normalise(heading)
    ? markdown.slice(match[0].length).trim()
    : markdown
}

/** One AI section's Markdown. */
export async function generateSection(
  target: ChatTarget,
  section: SectionRequest,
  transcript: string,
  values: PlaceholderValues,
  signal?: AbortSignal
): Promise<string> {
  const content = await complete(target, sectionMessages(section, transcript, values), { signal })
  const heading = fillTemplatePlaceholders(section.heading, values)
  return withoutRepeatedHeading(parseMarkdownAnswer(content), heading)
}

/** The AI sections of a template, with an id each (built-ins have none). */
export function templateSections(
  structure: readonly TranscriptionTemplateBlock[]
): SectionRequest[] {
  return structure.flatMap((block, index) =>
    block.type === 'section'
      ? [
          {
            id: block.id ?? `section-${index}`,
            heading: block.heading,
            instruction: block.instruction
          }
        ]
      : []
  )
}

/**
 * The template as Markdown: static blocks with placeholders filled, AI sections as `## Heading`
 * (none for a section without heading) followed by their generated content.
 */
export function assembleSummary(
  structure: readonly TranscriptionTemplateBlock[],
  values: PlaceholderValues,
  sections: Readonly<Record<string, string>>
): string {
  const fill = (text: string): string => fillTemplatePlaceholders(text, values)
  const parts = structure.flatMap((block, index): string[] => {
    switch (block.type) {
      case 'heading': {
        const text = fill(block.text).trim()
        return text ? [`${'#'.repeat(block.level)} ${text}`] : []
      }
      case 'text': {
        const text = fill(block.text).trim()
        return text ? [text] : []
      }
      case 'divider':
        return ['---']
      case 'section': {
        const content = (sections[block.id ?? `section-${index}`] ?? '').trim()
        const heading = fill(block.heading).trim()
        return [heading ? `## ${heading}\n\n${content}`.trim() : content].filter(Boolean)
      }
    }
  })
  return parts.join('\n\n')
}

/** Writes the whole summary of a template; any failed section fails it. */
export async function generateSummary(
  target: ChatTarget,
  structure: readonly TranscriptionTemplateBlock[],
  transcript: string,
  values: PlaceholderValues,
  signal?: AbortSignal
): Promise<string> {
  const sections = templateSections(structure)
  const contents = await mapLimited(sections, SECTION_CONCURRENCY, (section) =>
    generateSection(target, section, transcript, values, signal)
  )
  return assembleSummary(
    structure,
    values,
    Object.fromEntries(sections.map((section, index) => [section.id, contents[index]!]))
  )
}

/**
 * The previews of the sections asked for, each on its own: a failed section lands in `errors`
 * and does not fail the others.
 */
export async function generatePreviews(
  target: ChatTarget,
  sections: readonly SectionRequest[],
  excerpt: string,
  values: PlaceholderValues,
  signal?: AbortSignal
): Promise<{ results: Record<string, string>; errors: Record<string, string> }> {
  const results: Record<string, string> = {}
  const errors: Record<string, string> = {}
  await mapLimited(sections, SECTION_CONCURRENCY, async (section) => {
    try {
      results[section.id] = await generateSection(target, section, excerpt, values, signal)
    } catch (error) {
      console.error('Transcription section preview failed', error)
      errors[section.id] =
        error instanceof Error && error.name === 'UpstreamError'
          ? error.message
          : 'The chat model did not answer'
    }
  })
  return { results, errors }
}

/** A stable short hash of some JSON value, for cache keys. */
export function hashOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32)
}

/**
 * What a stored summary depends on besides revision, template version and model: the prompt
 * version, the template's blocks and the placeholder values (a generated title changes those
 * without a new revision).
 */
export function summarySettingsHash(
  structure: readonly TranscriptionTemplateBlock[],
  values: PlaceholderValues
): string {
  return hashOf({ prompt: PROMPT_VERSION, structure, values })
}

/** A preview section is cached by its heading and instruction, as kiChat keys them. */
export function previewKey(section: Pick<SectionRequest, 'heading' | 'instruction'>): string {
  return hashOf({
    prompt: PROMPT_VERSION,
    heading: section.heading,
    instruction: section.instruction
  })
}
