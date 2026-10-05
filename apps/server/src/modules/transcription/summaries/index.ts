import {
  transcriptionSummaryPreviewRequestSchema,
  transcriptionSummaryPreviewSchema,
  transcriptionSummaryRequestSchema,
  transcriptionSummaryResponseSchema,
  type TranscriptionSummary
} from '@justcampus/shared'
import { Hono, type Context } from 'hono'

import { ApiError, parseBody } from '../../../api.js'
import { getModuleRuntime } from '../../context.js'
import type { AppEnvironment } from '../../types.js'
import { upstream } from '../http.js'
import { findTemplate } from '../templates/store.js'
import {
  findTranscript,
  rememberSummaryTemplate,
  type TranscriptRow
} from '../transcripts/store.js'
import {
  participants,
  participantsOfText,
  placeholderValues,
  redactedText,
  speakerText,
  UNKNOWN_SPEAKER,
  type PlaceholderValues
} from '../transcripts/text.js'
import { chatTarget, requireChatTarget } from './chat.js'
import {
  generatePreviews,
  generateSummary,
  previewKey,
  reducedTranscriptSample,
  summarySettingsHash
} from './generate.js'
import { findPreviews, findSummary, storePreviews, storeSummary } from './store.js'

/** Summaries by template, cached per revision, and AI section previews (`TRANSCRIPTION_API.summaries`). */
export const summariesRouter = new Hono<AppEnvironment>()

/** What a summary is made of: the text the model reads and the placeholder values. */
interface SummarySource {
  text: string
  /** One `Name: text` line per segment, which previews sample (kiChat's segment lines). */
  lines: string[]
  values: PlaceholderValues
  /** The saved transcript, if one was named; only those are stored. */
  transcript: TranscriptRow | null
}

/** Title of an unsaved transcript, which the request does not name. */
const UNSAVED_TITLE = 'Transkript'

/**
 * A saved transcript of the user's as `Name: text` lines with its redactions applied, or the
 * text an unsaved one sent (already redacted by the browser, T-49).
 */
async function summarySource(
  context: Context<AppEnvironment>,
  input: { transcriptId: string | null; transcriptText: string | null }
): Promise<SummarySource> {
  const { componentId } = getModuleRuntime(context, 'transcription')
  let source: SummarySource
  if (input.transcriptId !== null) {
    const row = await findTranscript(
      componentId,
      context.get('session').user.id,
      input.transcriptId
    )
    if (!row) throw new ApiError(404, 'not_found', 'Transcript not found')
    source = {
      text: speakerText(row.segments),
      lines: row.segments.map(
        (segment) => `${segment.speaker?.trim() || UNKNOWN_SPEAKER}: ${redactedText(segment)}`
      ),
      values: placeholderValues({
        title: row.title,
        date: row.createdAt,
        participants: participants(row.segments),
        duration: row.duration
      }),
      transcript: row
    }
  } else {
    const text = input.transcriptText ?? ''
    source = {
      text,
      lines: text.split('\n').filter((line) => line.trim()),
      values: placeholderValues({
        title: UNSAVED_TITLE,
        date: new Date(),
        participants: participantsOfText(text),
        duration: null
      }),
      transcript: null
    }
  }
  if (!source.text.trim()) {
    throw new ApiError(400, 'validation', 'Request validation failed', [
      { path: ['transcriptText'], message: 'The transcript has no text' }
    ])
  }
  return source
}

/**
 * A summary by template (T-48, T-49). A stored one for the same revision, template version, model
 * and settings answers unless `forceRegenerate`; `checkOnly` only looks one up and answers
 * `summary: null` without. Unsaved text is never stored. The answer names the title the
 * placeholders were filled with, which a generated title changes without a new revision.
 */
summariesRouter.post('/summaries', async (context) => {
  const input = await parseBody(context, transcriptionSummaryRequestSchema)
  const runtime = getModuleRuntime(context, 'transcription')
  const userId = context.get('session').user.id
  const found = await findTemplate(runtime.componentId, userId, input.templateId)
  if (!found) throw new ApiError(404, 'not_found', 'Template not found')
  const { template } = found
  const source = await summarySource(context, input)
  const target = chatTarget(runtime, 'summary', input.model)
  const transcript = source.transcript
  const key =
    transcript && target
      ? {
          componentId: runtime.componentId,
          userId,
          transcriptId: transcript.id,
          templateId: template.id,
          templateVersion: template.version,
          transcriptRevision: transcript.revision,
          model: target.model,
          settingsHash: summarySettingsHash(template.structure, source.values)
        }
      : null
  const answer = (summary: TranscriptionSummary | null): Response =>
    context.json(transcriptionSummaryResponseSchema.parse({ summary }))

  if (key && transcript && !input.forceRegenerate) {
    const stored = await findSummary(key)
    if (stored) {
      return answer({
        markdown: stored.markdown,
        templateId: template.id,
        templateVersion: template.version,
        transcriptRevision: key.transcriptRevision,
        transcriptTitle: transcript.title,
        model: key.model,
        generatedAt: stored.generatedAt.toISOString(),
        cached: true
      })
    }
  }
  if (input.checkOnly) return answer(null)

  const chat = target ?? requireChatTarget(runtime, 'summary', input.model)
  const markdown = await upstream('The chat model did not write the summary', () =>
    generateSummary(chat, template.structure, source.text, source.values, context.req.raw.signal)
  )
  const generatedAt = new Date()
  if (key && transcript) {
    await storeSummary(key, markdown, generatedAt)
    await rememberSummaryTemplate(transcript.id, template.id)
  }
  return answer({
    markdown,
    templateId: template.id,
    templateVersion: template.version,
    transcriptRevision: transcript?.revision ?? null,
    transcriptTitle: transcript?.title ?? null,
    model: chat.model,
    generatedAt: generatedAt.toISOString(),
    cached: false
  })
})

/**
 * Previews of a template's AI sections on kiChat's reduced sample of the transcript (T-53). With
 * `staleSectionIds` only those are generated anew and answered; without, every section sent is
 * answered, from the store where its heading and instruction were previewed before. Sections
 * that fail appear in `errors`.
 */
summariesRouter.post('/summaries/preview', async (context) => {
  const input = await parseBody(context, transcriptionSummaryPreviewRequestSchema)
  const runtime = getModuleRuntime(context, 'transcription')
  const userId = context.get('session').user.id
  const source = await summarySource(context, input)
  const target = requireChatTarget(runtime, 'summary', input.model)
  const stale = new Set(input.staleSectionIds)
  const requested =
    stale.size > 0 ? input.sections.filter((section) => stale.has(section.id)) : input.sections
  const transcript = source.transcript
  const key = transcript
    ? {
        componentId: runtime.componentId,
        userId,
        transcriptId: transcript.id,
        transcriptRevision: transcript.revision,
        model: target.model
      }
    : null

  const stored = key && stale.size === 0 ? await findPreviews(key) : {}
  const results: Record<string, string> = {}
  const missing = requested.filter((section) => {
    const cached = stored[previewKey(section)]
    if (cached !== undefined) results[section.id] = cached
    return cached === undefined
  })
  const generated = await generatePreviews(
    target,
    missing,
    reducedTranscriptSample(source.lines),
    source.values,
    context.req.raw.signal
  )
  Object.assign(results, generated.results)
  if (key) {
    await storePreviews(
      key,
      Object.fromEntries(
        missing.flatMap((section) =>
          generated.results[section.id] !== undefined
            ? [[previewKey(section), generated.results[section.id]!]]
            : []
        )
      )
    )
  }
  return context.json(
    transcriptionSummaryPreviewSchema.parse({ results, errors: generated.errors })
  )
})
