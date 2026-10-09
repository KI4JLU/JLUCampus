import { describe, expect, it, vi } from 'vitest'
import {
  joinTranslated,
  keepVerbatim,
  MisalignedTranslationError,
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

  it('keeps lines of syntax only in the structure', () => {
    expect(splitMarkdown('-\nText')).toEqual({ texts: ['Text'], joints: ['-\n', ''] })
    expect(splitMarkdown('- \nText')).toEqual({ texts: ['Text'], joints: ['- \n', ''] })
    expect(splitMarkdown('**\n---\nText')).toEqual({ texts: ['Text'], joints: ['**\n---\n', ''] })
  })

  it('keeps task boxes with the list marker', () => {
    expect(splitMarkdown('- [x] Erledigt')).toEqual({ texts: ['Erledigt'], joints: ['- [x] ', ''] })
  })

  it('leaves code blocks alone, up to the matching fence', () => {
    const text = 'Vorher\n```ts\nconst a = 1\n~~~\n```\nNachher'
    expect(splitMarkdown(text)).toEqual({
      texts: ['Vorher', 'Nachher'],
      joints: ['', '\n```ts\nconst a = 1\n~~~\n```\n', '']
    })
  })

  it('translates table cells one by one and keeps pipes and the delimiter row', () => {
    const text = '| Name | Wert |\n| --- | :-: |\n| Eins | Zwei |'
    const { texts, joints } = splitMarkdown(text)
    expect(texts).toEqual(['Name', 'Wert', 'Eins', 'Zwei'])
    expect(joinTranslated(joints, texts)).toBe(text)
  })
})

describe('keepVerbatim', () => {
  it('puts link destinations and inline code back', () => {
    expect(
      keepVerbatim(
        'Siehe [Seite](https://a.de/x "Titel") und `npm ci`.',
        'See [page](https://a.de/y "Title") and `npm install`.'
      )
    ).toBe('See [page](https://a.de/x "Titel") and `npm ci`.')
  })

  it('leaves the translation as it is when the counts differ', () => {
    expect(keepVerbatim('[a](x) [b](y)', '[a](z)')).toBe('[a](z)')
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

  it('rejects answers that do not line up', async () => {
    const run = (text: string[]): Promise<unknown> =>
      translateAnnouncementText({ title: 'Titel', body: 'Eins\nZwei' }, 'de', 'en', async () => ({
        text
      }))
    await expect(run(['Title', 'One'])).rejects.toBeInstanceOf(MisalignedTranslationError)
    // How the model engine answers when it lost count: everything in the first piece.
    await expect(run(['Title One Two', '', ''])).rejects.toBeInstanceOf(MisalignedTranslationError)
  })
})
