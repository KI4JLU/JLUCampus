import {
  TRANSCRIPTION_SUBTITLE_MAX,
  TRANSCRIPTION_TITLE_MAX,
  type TranscriptionSegment
} from '@justcampus/shared'

import { client } from '../../../db/index.js'
import { TRANSCRIPTION_EVENTS_CHANNEL } from '../events/hub.js'
import { chatTarget, complete, withoutThinking, type ChatTarget } from '../summaries/chat.js'
import type { TranscriptionRuntime } from '../config.js'
import { applyGeneratedMetadata } from './store.js'
import { redactedText, UNKNOWN_SPEAKER } from './text.js'

/**
 * The title (for a title nobody chose) and the subtitle the chat model writes after saving, with
 * the prompts and budgets of kiChat's `GenerateTranscriptionTitle` and
 * `GenerateTranscriptionSubtitle` jobs. The event stream tells the web app when to fetch them (T-23).
 * A subtitle the user typed meanwhile always wins.
 */

/**
 * kiChat's "Name Prompt" (`AiAssistantPromptSeeder`), which also names its chats, by the user's
 * language; German unless the user reads English.
 */
export const TITLE_PROMPTS = {
  de: 'Du bist ein Assistent, der einem erhaltenen Nachrichtentext einen drei Wörter umfassenden Titel zuweist. Du antwortest nur mit dem Namen. Der Name beschreibt die Nachricht genau. Die Benennung soll auf Deutsch sein. Die Eingabe kann aus Dateinamen, Anfrage und Antwort bestehen - benenne das gemeinsame Thema. Kommentiere niemals Inhalte, die du nicht sehen kannst, und melde nichts als fehlend.',
  en: 'You are an assistant who assigns a three-word title to the message you receive. You only respond with the name. The naming accurately describes the message. The naming should be in english. The input may consist of file names, a request and the answer to it - name the topic they share. Never comment on content you cannot see, and never report anything as missing.'
} as const

/** Characters of the transcript the title is made from (kiChat: 500, then `...`). */
const TITLE_INPUT_MAX = 500

/**
 * Tokens the title may take. kiChat allows 10, which Qwen3's tokenizer can spend on one German
 * compound and a half ("Transkriptionstest Universität Gießen" took all 10 at the HRZ); 20 leave
 * room for three words without inviting more.
 */
export const TITLE_MAX_TOKENS = 20

/** kiChat's subtitle prompt, a system and a user message. */
export const SUBTITLE_SYSTEM_PROMPT =
  'Du formulierst eine einzelne, sehr kurze Unterzeile für ein Besprechungstranskript. Antworte ausschließlich mit dieser einen Zeile, in der Sprache des Transkripts, maximal 80 Zeichen, ohne Anführungszeichen, ohne Satzzeichen am Ende, ohne Markdown und ohne Einleitung.'
export const SUBTITLE_REQUEST =
  'Worum geht es in dieser Aufnahme? Formuliere eine sachliche Unterzeile, die das Thema benennt.'

/** kiChat's subtitle budget: 60 tokens out, the first 200 tokens (800 characters) in. */
export const SUBTITLE_MAX_TOKENS = 60
const SUBTITLE_HEAD_TOKENS = 200

/** The subtitle's target length; longer answers are cut at a word. */
const SUBTITLE_TARGET = 80

/**
 * Whether a title is one the app made up rather than the user: the first file's name with or
 * without extension, Campus's group names (`Transcript 2`, `Gruppe 1`), and what kiChat treats as
 * made up (a name followed by `dd.mm.yyyy HH:MM`, anything starting with `Transkription `).
 */
export function isDefaultTitle(title: string, firstFilename: string | null): boolean {
  const trimmed = title.trim()
  if (/^(?:Gruppe|Group|Transkript|Transcript|Aufnahme|Recording)\s*\d*$/i.test(trimmed))
    return true
  if (/^.* \d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$/.test(trimmed) || trimmed.startsWith('Transkription '))
    return true
  if (!firstFilename) return false
  const stem = firstFilename.replace(/\.[^.]+$/, '')
  return trimmed === firstFilename.trim() || trimmed === stem.trim()
}

type MetadataSegment = Pick<
  TranscriptionSegment,
  'start' | 'end' | 'speaker' | 'text' | 'redactions'
>

/** The whole text, redactions applied and whitespace collapsed, as kiChat names it. */
function normalizedText(segments: readonly MetadataSegment[]): string {
  return segments
    .map((segment) => redactedText(segment))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The title prompt's language for a user's (`de`, `en-GB`, `null`). */
export function titleLanguage(userLocale: string | null): keyof typeof TITLE_PROMPTS {
  return userLocale?.toLowerCase().startsWith('en') ? 'en' : 'de'
}

/** What the title model reads: the first 500 characters, `...` if there is more. */
export function titleInput(segments: readonly MetadataSegment[]): string {
  const text = normalizedText(segments)
  return text.length > TITLE_INPUT_MAX ? `${text.slice(0, TITLE_INPUT_MAX)}...` : text
}

/**
 * Whether the model reported missing content instead of naming it (kiChat's
 * `reportsMissingContent`), which is no title.
 */
export function reportsMissingContent(title: string): boolean {
  const normalized = title.replace(/\s+/g, ' ').trim()
  return [
    /^(kein|keine|keinen)\b.{0,30}\b(vorhanden|erhalten|gefunden|verf(ü|ue)gbar|angeh(ä|ae)ngt|übermittelt)\b/iu,
    /^no\b.{0,30}\b(provided|available|received|found|attached|given)\b/i
  ].some((pattern) => pattern.test(normalized))
}

/**
 * The title of the model's answer, or `null` when it is none: thinking and Markdown removed, the
 * first line, quotes around it dropped; empty answers, `INTERNAL ERROR:` and reports of missing
 * content do not count (kiChat's `isValidGeneratedTitle`).
 */
export function parseTitleAnswer(content: string): string | null {
  const line = withoutThinking(content)
    .split(/\r\n|\r|\n/)
    .map((candidate) => candidate.replace(/[*_`#]+/g, '').trim())
    .find(Boolean)
  if (!line) return null
  const title = line
    .replace(/^(?:Titel|Title)\s*:\s*/i, '')
    .replace(/^["'„“”‚‘’«»]+|["'„“”‚‘’«»]+$/g, '')
    .trim()
    .slice(0, TRANSCRIPTION_TITLE_MAX)
    .trim()
  if (!title || title.toUpperCase().startsWith('INTERNAL ERROR:') || reportsMissingContent(title))
    return null
  return title
}

/** kiChat's title when the model gave none: the first 50 characters of the text and `...`. */
export function fallbackTitle(segments: readonly MetadataSegment[]): string | null {
  const text = normalizedText(segments)
  return text ? `${text.slice(0, 50)}...` : null
}

/**
 * The start of the transcript for the subtitle, kiChat's `getTranscriptHead`: `Name: text` lines
 * up to 200 tokens (four characters each), else the plain text with the same budget.
 */
export function transcriptHead(
  segments: readonly MetadataSegment[],
  maxTokens: number = SUBTITLE_HEAD_TOKENS
): string {
  const maxChars = maxTokens * 4
  let head = ''
  for (const segment of segments) {
    const text = redactedText(segment)
    if (!text) continue
    head += `${segment.speaker?.trim() || UNKNOWN_SPEAKER}: ${text}\n`
    if (head.length >= maxChars) break
  }
  const sample = head.slice(0, maxChars).trim()
  return sample || normalizedText(segments).slice(0, maxChars)
}

/**
 * The model's answer as one subtitle line, or `null` when it is unusable (kiChat's
 * `sanitizeGeneratedSubtitle`): the first line that does not end in a colon (an introduction such
 * as "Hier die Unterzeile:"), Markdown, wrapping quotes and trailing punctuation removed, longer
 * than 80 characters cut at a word, more than 200 dropped.
 */
export function sanitizeSubtitle(content: string): string | null {
  const lines = withoutThinking(content)
    .split(/\r\n|\r|\n/)
    .map((candidate) => candidate.trim())
    .filter(Boolean)
  let line = ''
  for (const candidate of lines) {
    line = candidate
    if (!candidate.endsWith(':')) break
  }
  line = line
    .replace(/[*_`#>]+/gu, '')
    .replace(/\s+/gu, ' ')
    .replace(/^[\s"'«»„“”‚‘’:\-–—]+|[\s"'«»„“”‚‘’:\-–—]+$/gu, '')
    .replace(/[\s.,;:!]+$/u, '')
  if (!line || line.length > 200 || line.toUpperCase().startsWith('INTERNAL ERROR:')) return null
  if (line.length > SUBTITLE_TARGET) {
    line = line.slice(0, SUBTITLE_TARGET)
    const lastSpace = line.lastIndexOf(' ')
    if (lastSpace > 40) line = line.slice(0, lastSpace)
    line = line.replace(/[\s.,;:!\-–—]+$/u, '')
  }
  return line ? line.slice(0, TRANSCRIPTION_SUBTITLE_MAX) : null
}

/** A title from the chat model, kiChat's fallback if it named none; `null` without text. */
export async function generateTitle(
  target: ChatTarget,
  segments: readonly MetadataSegment[],
  userLocale: string | null,
  signal?: AbortSignal
): Promise<string | null> {
  const input = titleInput(segments)
  if (!input) return null
  const content = await complete(
    target,
    [
      { role: 'system', content: TITLE_PROMPTS[titleLanguage(userLocale)] },
      { role: 'user', content: input }
    ],
    { maxTokens: TITLE_MAX_TOKENS, signal }
  )
  return parseTitleAnswer(content) ?? fallbackTitle(segments)
}

/** A subtitle from the chat model; `null` without text or when its answer is unusable. */
export async function generateSubtitle(
  target: ChatTarget,
  segments: readonly MetadataSegment[],
  signal?: AbortSignal
): Promise<string | null> {
  const head = transcriptHead(segments)
  if (!head) return null
  const content = await complete(
    target,
    [
      { role: 'system', content: SUBTITLE_SYSTEM_PROMPT },
      { role: 'user', content: `${SUBTITLE_REQUEST}\n\nTRANSKRIPT-ANFANG:\n${head}` }
    ],
    { maxTokens: SUBTITLE_MAX_TOKENS, signal }
  )
  return sanitizeSubtitle(content)
}

/**
 * Generates and stores the subtitle and, for a made-up title, the title of a transcript just
 * saved, as two requests like kiChat's two jobs, with the model of the quick tasks. Runs after the
 * answer; failures are logged only, as the transcript stands without them.
 */
export async function generateMetadataAfterSave(
  runtime: Pick<TranscriptionRuntime, 'config' | 'secrets'>,
  transcript: {
    id: string
    componentId: string
    userId: string
    title: string
    segments: readonly MetadataSegment[]
    originalFilename: string | null
    userLocale: string | null
  }
): Promise<void> {
  try {
    const target = chatTarget(runtime, 'correction')
    if (!target) return
    const withTitle = isDefaultTitle(transcript.title, transcript.originalFilename)
    const [title, subtitle] = await Promise.allSettled([
      withTitle ? generateTitle(target, transcript.segments, transcript.userLocale) : null,
      generateSubtitle(target, transcript.segments)
    ])
    for (const result of [title, subtitle]) {
      if (result.status === 'rejected') {
        console.error(
          'Transcription title or subtitle generation failed',
          transcript.id,
          result.reason
        )
      }
    }
    try {
      await applyGeneratedMetadata(transcript.id, {
        title: title.status === 'fulfilled' ? title.value : null,
        subtitle: subtitle.status === 'fulfilled' ? subtitle.value : null,
        titleWas: transcript.title
      })
    } catch (error) {
      console.error('Transcription title or subtitle could not be stored', transcript.id, error)
    }
  } finally {
    try {
      await client.notify(
        TRANSCRIPTION_EVENTS_CHANNEL,
        JSON.stringify({
          type: 'transcriptMetadata',
          id: transcript.id,
          componentId: transcript.componentId,
          userId: transcript.userId
        })
      )
    } catch (error) {
      console.error('Transcription metadata notification failed', transcript.id, error)
    }
  }
}
