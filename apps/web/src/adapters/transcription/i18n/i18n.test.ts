import { describe, expect, it } from 'vitest'
import { transcriptionResources } from '.'

type Tree = { [key: string]: string | Tree }

/** Every leaf as `path → text`. */
function leaves(tree: Tree, prefix = ''): Map<string, string> {
  const result = new Map<string, string>()
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') result.set(path, value)
    else for (const [inner, text] of leaves(value, path)) result.set(inner, text)
  }
  return result
}

const placeholders = (text: string): string[] =>
  [...text.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]!).sort()

describe('transcription texts', () => {
  const de = leaves(transcriptionResources.de as unknown as Tree)
  const en = leaves(transcriptionResources.en as unknown as Tree)

  it('has every key in both languages', () => {
    expect([...en.keys()].sort()).toEqual([...de.keys()].sort())
  })

  it('uses the same placeholders in both languages, never kiChat single braces', () => {
    for (const [key, text] of de) {
      expect(placeholders(en.get(key) ?? ''), key).toEqual(placeholders(text))
      expect(/(?<!\{)\{\w+\}(?!\})/.test(text), key).toBe(false)
    }
  })

  it('keeps kiChat texts verbatim', () => {
    expect(de.get('common.choiceUploadTitle')).toBe('Datei hochladen')
    expect(en.get('upload.unsupportedFileAlert')).toBe(
      'We support .mp3, .wav, .m4a and .ogg.\n\nMaximum 500MB per file.'
    )
    expect(de.get('export.templateHint')).toBe('Wird nach deiner Vorlage „{{template}}“ erstellt.')
    expect(en.get('result.emptySpeakerHint')).toBe('[This speaker has no text yet!]')
  })
})
