import type { Language, TranslateRequest, TranslatorLanguage } from '@justcampus/shared'
import type { AnnouncementTextDraft } from './announcement-form'

/** The translator's language for each UI language; English announcements are British English. */
const TRANSLATOR_LANGUAGE: Record<Language, TranslatorLanguage> = { de: 'de', en: 'en-gb' }

/**
 * What starts a Markdown line without being text: indentation, list markers, heading hashes and
 * quote marks, possibly nested (`> - `).
 */
const LINE_PREFIX = /^[^\S\n]*(?:(?:[-*+]|\d{1,9}[.)])[^\S\n]+|#{1,6}[^\S\n]+|>[^\S\n]?)*/

/**
 * A Markdown text as the text of each line (`texts`) and what lies around it (`joints`: line
 * markers, indentation, line breaks and blank lines), so only the words go to the translator and
 * the structure stays as written. `joints` has one entry more than `texts`; `joinTranslated`
 * puts them back together.
 */
export function splitMarkdown(markdown: string): { texts: string[]; joints: string[] } {
  const texts: string[] = []
  const joints = ['']
  for (const line of markdown.split(/(?<=\n)/)) {
    const prefix = LINE_PREFIX.exec(line)?.[0] ?? ''
    const rest = line.slice(prefix.length)
    const text = rest.trim()
    if (!text) {
      joints[joints.length - 1] += line
      continue
    }
    const start = rest.indexOf(text)
    joints[joints.length - 1] += prefix + rest.slice(0, start)
    texts.push(text)
    joints.push(rest.slice(start + text.length))
  }
  return { texts, joints }
}

/** The text `splitMarkdown` took apart, with `texts` (trimmed) in place of its lines' text. */
export function joinTranslated(joints: readonly string[], texts: readonly string[]): string {
  return joints.reduce(
    (result, joint, index) => result + joint + (index < texts.length ? texts[index]!.trim() : ''),
    ''
  )
}

/**
 * Translates an announcement's title and Markdown text from one UI language into another with
 * the translator's default engine, in one request: the title first, then the text line by line.
 */
export async function translateAnnouncementText(
  text: AnnouncementTextDraft,
  from: Language,
  to: Language,
  translate: (request: TranslateRequest) => Promise<{ text: string[] }>
): Promise<AnnouncementTextDraft> {
  const body = splitMarkdown(text.body)
  const result = await translate({
    text: [text.title.trim(), ...body.texts],
    source: TRANSLATOR_LANGUAGE[from],
    target: TRANSLATOR_LANGUAGE[to]
  })
  const [title = '', ...lines] = result.text
  return { title: title.trim(), body: joinTranslated(body.joints, lines) }
}
