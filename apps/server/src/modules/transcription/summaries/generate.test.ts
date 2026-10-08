import {
  TRANSCRIPTION_BUILTIN_TEMPLATES,
  type TranscriptionTemplateBlock
} from '@justcampus/shared'
import { describe, expect, it } from 'vitest'

import { parseJsonObject, parseMarkdownAnswer, withoutThinking } from './chat.js'
import {
  assembleSummary,
  previewKey,
  reducedTranscriptSample,
  sectionMessages,
  SUMMARY_SYSTEM_PROMPT,
  summarySettingsHash,
  templateSections,
  withoutRepeatedHeading
} from './generate.js'

const values = {
  title: 'Teamsitzung',
  date: '04.10.2026',
  participants: 'Anna, Ben',
  duration: '45 Min'
}

describe('assembleSummary', () => {
  it('writes only the sections as level-2 headings with their content, as kiChat', () => {
    const structure: TranscriptionTemplateBlock[] = [
      { type: 'heading', level: 1, text: 'Protokoll: {{title}}' },
      { type: 'text', text: 'Am {{datum}} mit {{teilnehmer}} ({{dauer}}), {{titel}}' },
      { type: 'section', id: 'summary', heading: 'Zusammenfassung', instruction: 'x' },
      { type: 'divider' },
      { type: 'section', id: 'tasks', heading: 'Aufgaben für {{teilnehmer}}', instruction: 'x' },
      { type: 'heading', level: 3, text: '' }
    ]
    const markdown = assembleSummary(structure, values, {
      summary: 'Kurz.',
      tasks: '- Raum buchen'
    })
    // `kc-files/summary.md`: no title, date or rule; one newline after each heading.
    expect(markdown).toBe('## Zusammenfassung\nKurz.\n\n## Aufgaben für Anna, Ben\n- Raum buchen')
    expect(markdown).not.toMatch(/\{\{/)
  })

  it('writes a section without heading as the whole document, as the standard protocol', () => {
    const legacy = TRANSCRIPTION_BUILTIN_TEMPLATES.find((template) => template.id === 'legacy')!
    const sections = templateSections(legacy.structure)
    expect(sections).toHaveLength(1)
    expect(
      assembleSummary(legacy.structure, values, { [sections[0]!.id]: '# Thema\n\nText' })
    ).toBe('# Thema\n\nText')
  })

  it('names the built-ins’ sections by position', () => {
    const interview = TRANSCRIPTION_BUILTIN_TEMPLATES.find(
      (template) => template.id === 'interview'
    )!
    expect(templateSections(interview.structure).map((section) => section.id)).toEqual([
      'section-2',
      'section-3',
      'section-4'
    ])
  })
})

describe('prompts and answers', () => {
  it('sends kiChat’s system prompt and the instruction before the transcript', () => {
    const messages = sectionMessages(
      { instruction: 'Extrahiere Zitate von {{teilnehmer}}.' },
      'Anna: Hallo.\nBen: Hallo zurück.',
      values
    )
    expect(messages).toEqual([
      { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
      {
        role: 'user',
        content: 'Extrahiere Zitate von Anna, Ben.\n\nTRANSKRIPT:\nAnna: Hallo.\nBen: Hallo zurück.'
      }
    ])
    expect(SUMMARY_SYSTEM_PROMPT).toBe(
      'Du bist ein hilfreicher Assistent, der Transkripte präzise und professionell zusammenfasst.'
    )
  })

  it('tells the model not to guess redacted passages, only when there are some', () => {
    const [system] = sectionMessages(
      { instruction: 'x' },
      'Anna: Ich war in [AUSGEBLENDET].',
      values
    )
    expect(system!.content).toContain(SUMMARY_SYSTEM_PROMPT)
    expect(system!.content).toContain('[AUSGEBLENDET] markiert')
  })

  it('samples beginning, middle and end as kiChat’s reduced transcript', () => {
    const lines = Array.from({ length: 300 }, (_, index) => `Anna: Satz ${index} ${'x'.repeat(40)}`)
    const sample = reducedTranscriptSample(lines)
    const parts = sample.split('\n... [Ausschnitt] ...\n\n')
    expect(parts).toHaveLength(3)
    expect(parts[0]!.startsWith('Anna: Satz 0 ')).toBe(true)
    expect(parts[1]).toContain('Anna: Satz 149 ')
    expect(parts[2]!.trimEnd().endsWith(`Satz 299 ${'x'.repeat(40)}`)).toBe(true)
    // Three parts of a third of 2000 tokens at four characters each, plus a line at most.
    for (const part of parts) expect(part.length).toBeLessThan(2666 + 60)
    expect(reducedTranscriptSample(['Anna: kurz', 'Ben: auch'])).toBe('Anna: kurz\nBen: auch\n')
    expect(reducedTranscriptSample([])).toBe('')
  })

  it('reads Markdown from JSON, fences, thinking or plain prose', () => {
    expect(parseMarkdownAnswer('{"markdown": "- a\\n- b"}')).toBe('- a\n- b')
    expect(parseMarkdownAnswer('<think>…</think>\n```json\n{"markdown": "**x**"}\n```')).toBe(
      '**x**'
    )
    expect(parseMarkdownAnswer('```markdown\n## Titel\nText\n```')).toBe('## Titel\nText')
    expect(parseMarkdownAnswer('Nur Text.')).toBe('Nur Text.')
    expect(parseJsonObject('Antwort: {"a": "}"} danach')).toEqual({ a: '}' })
  })

  it('drops the thinking of reasoning models in every shape they send it', () => {
    expect(withoutThinking('<think>\nDer Nutzer will …\n</think>\n\n## Ergebnisse\n- a')).toBe(
      '## Ergebnisse\n- a'
    )
    // Templates that open the block in the prompt send only its end.
    expect(withoutThinking('Der Nutzer will eine Liste.\n</think>\n- a')).toBe('- a')
    // The budget ran out while thinking.
    expect(withoutThinking('- a\n<think>Noch nicht fert')).toBe('- a')
    expect(withoutThinking('<THINK>x</THINK>Text')).toBe('Text')
  })

  it('drops a heading that repeats the section’s own', () => {
    expect(withoutRepeatedHeading('## **Aufgaben:**\n\n- x', 'Aufgaben')).toBe('- x')
    expect(withoutRepeatedHeading('### Andere\n- x', 'Aufgaben')).toBe('### Andere\n- x')
  })
})

describe('cache keys', () => {
  it('change with the template’s blocks and the placeholder values', () => {
    const structure: TranscriptionTemplateBlock[] = [{ type: 'text', text: '{{title}}' }]
    const base = summarySettingsHash(structure, values)
    expect(summarySettingsHash(structure, values)).toBe(base)
    expect(summarySettingsHash(structure, { ...values, title: 'Neu' })).not.toBe(base)
    expect(summarySettingsHash([{ type: 'divider' }], values)).not.toBe(base)
  })

  it('key previews by heading and instruction', () => {
    const key = previewKey({ heading: 'A', instruction: 'x' })
    expect(previewKey({ heading: 'A', instruction: 'x' })).toBe(key)
    expect(previewKey({ heading: 'A', instruction: 'y' })).not.toBe(key)
    expect(previewKey({ heading: 'B', instruction: 'x' })).not.toBe(key)
  })
})
