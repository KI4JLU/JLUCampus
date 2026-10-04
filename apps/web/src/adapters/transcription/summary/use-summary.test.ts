import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import {
  transcriptionSummaryPreviewRequestSchema,
  transcriptionSummaryRequestSchema,
  type TranscriptionSegment,
  type TranscriptionSummary
} from '@justcampus/shared'
import { ApiRequestError } from '@/lib/api'
import type { TranscriptDocument } from '../workspace'
import { speakerText, summarySource, textFingerprint } from './source'
import {
  fileSummary,
  skeletonHeadlines,
  sourceKey,
  summaryErrorMessage,
  summaryKey,
  summaryKeyOf,
  summaryRequest,
  type SummaryTarget
} from './use-summary'

const texts = {
  prefix: 'Generierung fehlgeschlagen: ',
  serverError: 'Unbekannter Serverfehler',
  communicationError: 'Fehler bei der Kommunikation mit dem Server.'
}

const made: TranscriptionSummary = {
  markdown: '# A',
  templateId: 'mine',
  templateVersion: 1,
  transcriptRevision: 3,
  transcriptTitle: 'Teamsitzung',
  model: 'model-a',
  generatedAt: '2026-10-04T10:00:00.000Z',
  cached: false
}

function segment(
  start: number,
  speaker: string | null,
  text: string,
  redactions: TranscriptionSegment['redactions'] = []
): TranscriptionSegment {
  return { start, end: start + 1, speaker, text, redactions } as TranscriptionSegment
}

describe('summary', () => {
  it('keys a summary by transcript, revision, template, template version and model', () => {
    expect(summaryKey('t', 3, 'Teamsitzung', 'interview', 1, 'model-a')).toEqual([
      'transcription',
      'summary',
      't',
      3,
      'Teamsitzung',
      'interview',
      1,
      'model-a'
    ])
    const key = summaryKey('t', 3, 'Teamsitzung', 'interview', 1, 'model-a')
    expect(summaryKey('t', 4, 'Teamsitzung', 'interview', 1, 'model-a')).not.toEqual(key)
    // An edited template's summary is another one.
    expect(summaryKey('t', 3, 'Teamsitzung', 'interview', 2, 'model-a')).not.toEqual(key)
    // So is one of another model, after the admin changed the default.
    expect(summaryKey('t', 3, 'Teamsitzung', 'interview', 1, 'model-b')).not.toEqual(key)
  })

  it('files a summary under what it was made from', () => {
    // A late answer for version 1 stays there after the template became version 2.
    const v2 = summaryKey('t', 3, 'Teamsitzung', 'mine', 2, 'model-a')
    expect(summaryKeyOf(v2, made)).toEqual(summaryKey('t', 3, 'Teamsitzung', 'mine', 1, 'model-a'))

    const client = new QueryClient()
    client.setQueryData(['transcription', 'templates'], [])
    client.setQueryData(['transcription', 'capabilities'], {})
    expect(fileSummary(client, made, v2)).toBe(false)
    expect(client.getQueryData(v2)).toBeUndefined()
    expect(client.getQueryData(summaryKey('t', 3, 'Teamsitzung', 'mine', 1, 'model-a'))).toEqual(
      made
    )
    // The template list is asked again, in case the server's version is newer.
    expect(client.getQueryState(['transcription', 'templates'])?.isInvalidated).toBe(true)
    expect(client.getQueryState(['transcription', 'capabilities'])?.isInvalidated).toBe(false)
    expect(fileSummary(client, { ...made, templateVersion: 2 }, v2)).toBe(true)
  })

  it('never shows a summary of the old model once the module uses another', () => {
    const client = new QueryClient()
    client.setQueryData(['transcription', 'capabilities'], {})
    // The admin switched the default to model B; the view asks under B.
    const underB = summaryKey('t', 3, 'Teamsitzung', 'mine', 1, 'model-b')
    // A late answer of model A, generated before the switch, stays under A.
    expect(fileSummary(client, made, underB)).toBe(false)
    expect(client.getQueryData(underB)).toBeUndefined()
    expect(client.getQueryData(summaryKey('t', 3, 'Teamsitzung', 'mine', 1, 'model-a'))).toEqual(
      made
    )
    // A browser that still thinks A gets B's answer filed under B, and asks for the model again.
    const underA = summaryKey('t', 3, 'Teamsitzung', 'mine', 1, 'model-a')
    const ofB = { ...made, model: 'model-b' }
    const stale = new QueryClient()
    stale.setQueryData(['transcription', 'capabilities'], {})
    expect(fileSummary(stale, ofB, underA)).toBe(false)
    expect(stale.getQueryData(underA)).toBeUndefined()
    expect(stale.getQueryData(underB)).toEqual(ofB)
    expect(stale.getQueryState(['transcription', 'capabilities'])?.isInvalidated).toBe(true)
  })

  it('never shows a summary made with the title a generated one replaced', () => {
    // A generated title replaces the default one without a new revision.
    const before = summaryKey('t', 3, 'Transkript 1', 'mine', 1, 'model-a')
    const after = summaryKey('t', 3, 'Planung der Klausurtagung', 'mine', 1, 'model-a')
    expect(after).not.toEqual(before)
    const ofBefore = { ...made, transcriptTitle: 'Transkript 1' }
    const client = new QueryClient()
    client.setQueryData(before, ofBefore)
    expect(client.getQueryData(after)).toBeUndefined()

    // A late answer made with the old title stays under it once the view has the new one.
    const transcript = ['transcription', 'transcript', 't']
    client.setQueryData(transcript, { id: 't' })
    expect(summaryKeyOf(after, ofBefore)).toEqual(before)
    expect(fileSummary(client, ofBefore, after)).toBe(false)
    expect(client.getQueryData(after)).toBeUndefined()
    expect(client.getQueryState(transcript)?.isInvalidated).toBe(true)

    // A view that missed the new title gets the answer filed under it, and the transcript again.
    const stale = new QueryClient()
    stale.setQueryData(transcript, { id: 't' })
    const ofAfter = { ...made, transcriptTitle: 'Planung der Klausurtagung' }
    expect(fileSummary(stale, ofAfter, before)).toBe(false)
    expect(stale.getQueryData(before)).toBeUndefined()
    expect(stale.getQueryData(after)).toEqual(ofAfter)
    expect(stale.getQueryState(transcript)?.isInvalidated).toBe(true)
    expect(fileSummary(stale, ofAfter, after)).toBe(true)
  })

  it('summarises a local transcript from its redacted text and keeps the answer by that text', () => {
    const target: SummaryTarget = {
      transcriptId: 'local-1b4e28ba-2fa1-11d2-883f-0016d3cca427',
      revision: 1,
      title: null,
      text: 'Anna: Hallo [AUSGEBLENDET]',
      templateId: 'mine',
      templateVersion: 1,
      model: 'model-a'
    }
    // The local id is no UUID; the text goes instead, with the flags of generate and regenerate.
    expect(summaryRequest(target, false)).toEqual({
      transcriptText: 'Anna: Hallo [AUSGEBLENDET]',
      templateId: 'mine',
      forceRegenerate: false
    })
    expect(summaryRequest(target, true)).toMatchObject({ forceRegenerate: true })
    expect(summaryRequest({ ...target, transcriptId: 'saved', text: null }, true)).toEqual({
      transcriptId: 'saved',
      templateId: 'mine',
      forceRegenerate: true
    })

    // The key follows the text: an edit is another summary.
    const source = sourceKey(target)
    expect(source).toBe(`text:${textFingerprint(target.text!)}`)
    expect(sourceKey({ ...target, text: 'Anna: Hallo Welt' })).not.toBe(source)
    expect(sourceKey({ ...target, text: null })).toBe(1)

    // The server answers without a revision; the answer belongs to the text that was sent.
    const requested = summaryKey(target.transcriptId, source, null, 'mine', 1, 'model-a')
    const client = new QueryClient()
    const ofText = { ...made, transcriptRevision: null, transcriptTitle: null }
    expect(summaryKeyOf(requested, ofText)).toEqual(requested)
    expect(fileSummary(client, ofText, requested)).toBe(true)
    // A late answer for the template's older version stays there.
    const v2 = summaryKey(target.transcriptId, source, null, 'mine', 2, 'model-a')
    expect(fileSummary(client, ofText, v2)).toBe(false)
    expect(client.getQueryData(requested)).toEqual(ofText)
  })

  it('sends the text of a local transcript as the server reads a saved one', () => {
    const segments = [
      segment(0, 'Anna', 'Meine Nummer ist 0641 123.', [{ start: 17, end: 25 }]),
      segment(1, 'Anna', 'Danke.'),
      segment(2, null, 'Wer spricht?'),
      // More than ten seconds later: a new turn of the same speaker.
      segment(20, null, 'Ich.')
    ]
    expect(speakerText(segments)).toBe(
      'Anna: Meine Nummer ist [AUSGEBLENDET]. Danke.\nUnbekannt: Wer spricht?\nUnbekannt: Ich.'
    )
    const document = (id: string): TranscriptDocument =>
      ({ transcript: { id }, segments, speakerColors: {} }) as unknown as TranscriptDocument
    expect(summarySource(document('local-abc'))).toEqual({
      transcriptId: null,
      transcriptText: speakerText(segments)
    })
    expect(summarySource(document('8d2c1f0e-0000-4000-8000-000000000000'))).toEqual({
      transcriptId: '8d2c1f0e-0000-4000-8000-000000000000',
      transcriptText: null
    })
    // What the server accepts: the local id never goes out, its text does.
    const local = summarySource(document('local-abc'))
    expect(
      transcriptionSummaryRequestSchema.safeParse({ ...local, templateId: 'legacy' }).success
    ).toBe(true)
    expect(
      transcriptionSummaryPreviewRequestSchema.safeParse({
        ...local,
        sections: [{ id: 's1', heading: 'Kurz', instruction: 'Fasse zusammen.' }]
      }).success
    ).toBe(true)
    expect(
      transcriptionSummaryRequestSchema.safeParse({ transcriptId: 'local-abc', templateId: 'x' })
        .success
    ).toBe(false)
    expect(textFingerprint('a')).not.toBe(textFingerprint('b'))
    expect(textFingerprint('abc')).toBe(textFingerprint('abc'))
  })

  it("words failures as kiChat's", () => {
    const upstream = new ApiRequestError(502, {
      error: { code: 'module_unavailable', message: 'The chat model did not write the summary' }
    })
    expect(summaryErrorMessage(upstream, texts)).toBe(
      'Generierung fehlgeschlagen: The chat model did not write the summary'
    )
    expect(summaryErrorMessage(new ApiRequestError(500, null), texts)).toBe(
      'Unbekannter Serverfehler'
    )
    expect(summaryErrorMessage(new TypeError('Failed to fetch'), texts)).toBe(
      'Fehler bei der Kommunikation mit dem Server.'
    )
  })

  it("labels the skeleton with the template's sections, else kiChat's three", () => {
    const fallback = 'Zusammenfassung · Entscheidungen · Aufgaben'
    expect(skeletonHeadlines('Kernaussagen · Zitate · Themen', fallback)).toEqual([
      'Kernaussagen',
      'Zitate',
      'Themen'
    ])
    expect(skeletonHeadlines('', fallback)).toEqual([
      'Zusammenfassung',
      'Entscheidungen',
      'Aufgaben'
    ])
  })
})
