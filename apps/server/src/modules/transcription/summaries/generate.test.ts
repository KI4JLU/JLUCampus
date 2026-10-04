import {
  TRANSCRIPTION_BUILTIN_TEMPLATES,
  type TranscriptionTemplateBlock
} from '@justcampus/shared'
import { describe, expect, it } from 'vitest'

import { parseJsonObject, parseMarkdownAnswer } from './chat.js'
import {
  assembleSummary,
  buildSectionPrompt,
  previewKey,
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
  it('renders static blocks with every placeholder and alias filled, sections as level-2 headings', () => {
    const structure: TranscriptionTemplateBlock[] = [
      { type: 'heading', level: 1, text: 'Protokoll: {{title}}' },
      { type: 'text', text: 'Am {{datum}} mit {{teilnehmer}} ({{dauer}}), {{titel}}' },
      { type: 'divider' },
      { type: 'section', id: 'tasks', heading: 'Aufgaben für {{participants}}', instruction: 'x' },
      { type: 'heading', level: 3, text: '' }
    ]
    const markdown = assembleSummary(structure, values, { tasks: '- Raum buchen' })
    expect(markdown).toBe(
      [
        '# Protokoll: Teamsitzung',
        'Am 04.10.2026 mit Anna, Ben (45 Min), Teamsitzung',
        '---',
        '## Aufgaben für Anna, Ben\n\n- Raum buchen'
      ].join('\n\n')
    )
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
  it('asks in German for JSON, with the instruction, context and other sections', () => {
    const prompt = buildSectionPrompt(
      { heading: 'Zitate', instruction: 'Extrahiere Zitate von {{teilnehmer}}.' },
      values,
      ['Kernaussagen']
    )
    expect(prompt).toContain('Abschnitt "Zitate"')
    expect(prompt).toContain('Extrahiere Zitate von Anna, Ben.')
    expect(prompt).toContain('Datum 04.10.2026')
    expect(prompt).toContain('"Kernaussagen"')
    expect(prompt).toContain('[AUSGEBLENDET]')
    expect(prompt).toContain('{"markdown"')
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
