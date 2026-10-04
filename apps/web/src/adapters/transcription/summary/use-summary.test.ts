import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { ApiRequestError } from '@/lib/api'
import {
  skeletonHeadlines,
  summaryErrorMessage,
  summaryKey,
  summaryKeyOf,
  fileSummary
} from './use-summary'

const texts = {
  prefix: 'Generierung fehlgeschlagen: ',
  serverError: 'Unbekannter Serverfehler',
  communicationError: 'Fehler bei der Kommunikation mit dem Server.'
}

describe('summary', () => {
  it('keys a summary by transcript, revision, template and template version', () => {
    expect(summaryKey('t', 3, 'interview', 1)).toEqual([
      'transcription',
      'summary',
      't',
      3,
      'interview',
      1
    ])
    expect(summaryKey('t', 4, 'interview', 1)).not.toEqual(summaryKey('t', 3, 'interview', 1))
    // An edited template's summary is another one.
    expect(summaryKey('t', 3, 'mine', 2)).not.toEqual(summaryKey('t', 3, 'mine', 1))
  })

  it('files a summary under what it was made from', () => {
    const made = {
      markdown: '# A',
      templateId: 'mine',
      templateVersion: 1,
      transcriptRevision: 3,
      model: 'm',
      generatedAt: '2026-10-04T10:00:00.000Z',
      cached: false
    }
    // A late answer for version 1 stays there after the template became version 2.
    expect(summaryKeyOf('t', made)).toEqual(summaryKey('t', 3, 'mine', 1))
    expect(summaryKeyOf('t', { ...made, transcriptRevision: null })).toBeNull()

    const client = new QueryClient()
    client.setQueryData(['transcription', 'templates'], [])
    const v2 = summaryKey('t', 3, 'mine', 2)
    expect(fileSummary(client, 't', made, v2)).toBe(false)
    expect(client.getQueryData(v2)).toBeUndefined()
    expect(client.getQueryData(summaryKey('t', 3, 'mine', 1))).toEqual(made)
    // The template list is asked again, in case the server's version is newer.
    expect(client.getQueryState(['transcription', 'templates'])?.isInvalidated).toBe(true)
    expect(fileSummary(client, 't', { ...made, templateVersion: 2 }, v2)).toBe(true)
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
