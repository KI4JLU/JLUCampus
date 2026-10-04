import { describe, expect, it } from 'vitest'
import { ApiRequestError } from '@/lib/api'
import { skeletonHeadlines, summaryErrorMessage, summaryKey } from './use-summary'

const texts = {
  prefix: 'Generierung fehlgeschlagen: ',
  serverError: 'Unbekannter Serverfehler',
  communicationError: 'Fehler bei der Kommunikation mit dem Server.'
}

describe('summary', () => {
  it('keys a summary by transcript, revision and template', () => {
    expect(summaryKey('t', 3, 'interview')).toEqual([
      'transcription',
      'summary',
      't',
      3,
      'interview'
    ])
    expect(summaryKey('t', 4, 'interview')).not.toEqual(summaryKey('t', 3, 'interview'))
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
