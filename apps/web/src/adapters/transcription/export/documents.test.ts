import { describe, expect, it } from 'vitest'
import {
  documentDocx,
  documentPdf,
  markdownPlainText,
  parseInlineMarkdown,
  stripInlineMarkdown
} from './documents'

/** `/tmp/transcription-ref/summary.md`: the reference run's summary. */
const SUMMARY_MD = `## Zusammenfassung
Der Sprecher führt ein kurzer Test der Transkriptionsfunktion für die Universität Gießen durch. Er gibt an, dass sich die Beteiligten am Montag um 10 Uhr treffen werden. Das Gespräch ist rein informatorisch und endet ohne weitere inhaltliche Aussagen.

## Wichtigste Entscheidungen
- Treffen am Montag um 10 Uhr.

## Offene Aufgaben
**To-dos:**

Aus dem Transkript lassen sich **keine konkreten To-dos mit verantwortlicher Person** extrahieren.

---

**Einordnung:**

| Aussage | Art | Verantwortlich |
|---|---|---|
| „Wir treffen uns am Montag um 10 Uhr." | Termin (keine Handlungsanweisung) | *Wir* (nicht konkret benannt) |

Das Transkript dient explizit als **Test der Transkription** und enthält keine Aufgaben, Handlungsaufforderungen oder zugewiesenen Verantwortlichkeiten.

> **Hinweis:** Falls der Montagstermin als To-Do erfasst werden soll, müsste die verantwortliche Person(n) bzw. der konkrete Handlungsschritt (z. B. „Raum buchen", „Tagesordnung vorbereiten") im Gespräch genannt werden.`

/** `/tmp/transcription-ref/summary.txt`: what kiChat saved of it as text. */
const SUMMARY_TXT = `Zusammenfassung

Der Sprecher führt ein kurzer Test der Transkriptionsfunktion für die Universität Gießen durch. Er gibt an, dass sich die Beteiligten am Montag um 10 Uhr treffen werden. Das Gespräch ist rein informatorisch und endet ohne weitere inhaltliche Aussagen.

Wichtigste Entscheidungen
Treffen am Montag um 10 Uhr.
Offene Aufgaben

To-dos:

Aus dem Transkript lassen sich keine konkreten To-dos mit verantwortlicher Person extrahieren.

Einordnung:

Aussage	Art	Verantwortlich
„Wir treffen uns am Montag um 10 Uhr."	Termin (keine Handlungsanweisung)	Wir (nicht konkret benannt)

Das Transkript dient explizit als Test der Transkription und enthält keine Aufgaben, Handlungsaufforderungen oder zugewiesenen Verantwortlichkeiten.

Hinweis: Falls der Montagstermin als To-Do erfasst werden soll, müsste die verantwortliche Person(n) bzw. der konkrete Handlungsschritt (z. B. „Raum buchen", „Tagesordnung vorbereiten") im Gespräch genannt werden.`

describe('inline Markdown', () => {
  it('splits a line into formatted runs', () => {
    expect(
      parseInlineMarkdown('Ein **fetter**, *kursiver*, __unterstrichener__ und `Code`-Teil')
    ).toEqual([
      { text: 'Ein ' },
      { text: 'fetter', bold: true },
      { text: ', ' },
      { text: 'kursiver', italic: true },
      { text: ', ' },
      { text: 'unterstrichener', underline: true },
      { text: ' und ' },
      { text: 'Code', code: true },
      { text: '-Teil' }
    ])
    expect(parseInlineMarkdown('')).toEqual([])
  })

  it('drops the signs for the PDF', () => {
    expect(stripInlineMarkdown('**To-dos:** *Wir* `x` __u__')).toBe('To-dos: Wir x u')
  })
})

describe('markdownPlainText', () => {
  it('reads the reference summary as its preview did', () => {
    expect(markdownPlainText(SUMMARY_MD)).toBe(SUMMARY_TXT)
  })

  it('keeps numbered items and quotes as text', () => {
    expect(markdownPlainText('# Titel\n\n1. Eins\n2. Zwei\n\n> Zitat')).toBe(
      'Titel\nEins\nZwei\n\nZitat'
    )
  })
})

describe('documents', () => {
  it('writes a Word file', async () => {
    const blob = await documentDocx(SUMMARY_MD, 'Transcript 1', true)
    const bytes = new Uint8Array(await blob.arrayBuffer())
    // A ZIP container, as every .docx.
    expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b])
  })

  it('writes a PDF with the title for the running record', async () => {
    const blob = await documentPdf(
      'VERLAUFSPROTOKOLL\n\nTest speaker:\nGuten Tag.',
      'Transcript 1',
      false
    )
    const text = new TextDecoder('latin1').decode(await blob.arrayBuffer())
    expect(text.startsWith('%PDF-')).toBe(true)
    expect(text).toContain('(Transcript 1)')
    expect(text).toContain('/Helvetica-Bold')
  })

  it('breaks long PDFs into pages', async () => {
    const long = Array.from({ length: 120 }, (_, index) => `Zeile ${index}`).join('\n')
    const blob = await documentPdf(long, '', true)
    const text = new TextDecoder('latin1').decode(await blob.arrayBuffer())
    expect(text.match(/\/Type \/Page\b/g)?.length).toBeGreaterThan(1)
  })
})
