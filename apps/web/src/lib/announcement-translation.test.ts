import { describe, expect, it, vi } from 'vitest'
import {
  joinTranslated,
  splitMarkdown,
  translateAnnouncementText
} from './announcement-translation'

const BODY = `Wir haben ein Update eingespielt.

**Updates / Fixes:**

- **Sprecherfarben**
  Die Wellenform zeigt, wer spricht.
1. Erstens
> Zitat

## Fragen?
Schreibt an [ki@uni-giessen.de](mailto:ki@uni-giessen.de).${'  '}
Euer KI-Team`

describe('splitMarkdown', () => {
  it('sends only the words of each line and keeps markers, indentation and blank lines', () => {
    const { texts, joints } = splitMarkdown(BODY)
    expect(texts).toEqual([
      'Wir haben ein Update eingespielt.',
      '**Updates / Fixes:**',
      '**Sprecherfarben**',
      'Die Wellenform zeigt, wer spricht.',
      'Erstens',
      'Zitat',
      'Fragen?',
      'Schreibt an [ki@uni-giessen.de](mailto:ki@uni-giessen.de).',
      'Euer KI-Team'
    ])
    expect(joints).toEqual([
      '',
      '\n\n',
      '\n\n- ',
      '\n  ',
      '\n1. ',
      '\n> ',
      '\n\n## ',
      '\n',
      '  \n',
      ''
    ])
  })

  it('gives the text back when joined unchanged', () => {
    const { texts, joints } = splitMarkdown(BODY)
    expect(joinTranslated(joints, texts)).toBe(BODY)
  })

  it('keeps lines that are only a marker in the structure', () => {
    expect(splitMarkdown('-\nText')).toEqual({ texts: ['-', 'Text'], joints: ['', '\n', ''] })
    expect(splitMarkdown('- \nText')).toEqual({ texts: ['Text'], joints: ['- \n', ''] })
  })
})

describe('translateAnnouncementText', () => {
  it('translates title and lines in one request and rebuilds the Markdown', async () => {
    const translate = vi.fn(async ({ text }: { text: string[] }) => ({
      text: text.map((segment) => ` EN(${segment}) `)
    }))
    const result = await translateAnnouncementText(
      { title: ' Neuigkeit ', body: '- **Eins**\n  Zwei\n\nDrei' },
      'de',
      'en',
      translate
    )
    expect(translate).toHaveBeenCalledWith({
      text: ['Neuigkeit', '**Eins**', 'Zwei', 'Drei'],
      source: 'de',
      target: 'en-gb'
    })
    expect(result).toEqual({
      title: 'EN(Neuigkeit)',
      body: '- EN(**Eins**)\n  EN(Zwei)\n\nEN(Drei)'
    })
  })
})
