import type { Language, TranslateRequest, TranslatorLanguage } from '@justcampus/shared'
import type { AnnouncementTextDraft } from './announcement-form'

/** The translator's language for each UI language; English announcements are British English. */
const TRANSLATOR_LANGUAGE: Record<Language, TranslatorLanguage> = { de: 'de', en: 'en-gb' }

/**
 * What starts a Markdown line without being text: indentation, list markers (with a task box),
 * heading hashes and quote marks, possibly nested (`> - `).
 */
const LINE_PREFIX =
  /^[^\S\n]*(?:(?:[-*+]|\d{1,9}[.)])[^\S\n]+(?:\[[ xX]\][^\S\n]+)?|#{1,6}[^\S\n]+|>[^\S\n]?)*/

/** A code fence (``` or ~~~) opening or closing a block. */
const FENCE = /^[^\S\n]*(`{3,}|~{3,})/

/** A line of Markdown syntax only, such as a rule, a lone `**` or a table's delimiter row. */
const SYNTAX_ONLY = /^[\s|:*_\-=#>`~+]*$/

/** Link destinations and inline code: kept as written, whatever the engine makes of them. */
const LINK_DESTINATION = /\]\([^)\s]*(?:\s+"[^"]*")?\)/g
const INLINE_CODE = /`[^`\n]+`/g

/** The engine's answer does not line up with the request, so it cannot be put back together. */
export class MisalignedTranslationError extends Error {
  constructor() {
    super('The translation does not line up with the text')
    this.name = 'MisalignedTranslationError'
  }
}

/**
 * A Markdown text as its pieces of prose (`texts`) and what lies around them (`joints`: line
 * markers, indentation, line breaks, blank lines, code blocks, table pipes and lines of syntax
 * only), so only the words go to the translator and the structure stays as written. `joints` has
 * one entry more than `texts`; `joinTranslated` puts them back together.
 */
export function splitMarkdown(markdown: string): { texts: string[]; joints: string[] } {
  const texts: string[] = []
  const joints = ['']
  const keep = (part: string): void => {
    joints[joints.length - 1] += part
  }
  const translate = (part: string): void => {
    const text = part.trim()
    if (!text || SYNTAX_ONLY.test(text)) return keep(part)
    const start = part.indexOf(text)
    keep(part.slice(0, start))
    texts.push(text)
    joints.push(part.slice(start + text.length))
  }
  let fence: string | null = null
  for (const line of markdown.split(/(?<=\n)/)) {
    const marker = FENCE.exec(line)?.[1]
    if (fence !== null) {
      // Inside a code block nothing is prose; the block ends at a fence like the one it opened with.
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null
      keep(line)
      continue
    }
    if (marker) {
      fence = marker
      keep(line)
      continue
    }
    const prefix = LINE_PREFIX.exec(line)?.[0] ?? ''
    keep(prefix)
    const rest = line.slice(prefix.length)
    if (rest.trimStart().startsWith('|')) {
      // A table row: each cell on its own, the pipes stay.
      for (const cell of rest.split(/(\|)/)) {
        if (cell === '|') keep(cell)
        else translate(cell)
      }
    } else {
      translate(rest)
    }
  }
  return { texts, joints }
}

/** The text `splitMarkdown` took apart, with `texts` (trimmed) in place of its prose. */
export function joinTranslated(joints: readonly string[], texts: readonly string[]): string {
  return joints.reduce(
    (result, joint, index) => result + joint + (index < texts.length ? texts[index]!.trim() : ''),
    ''
  )
}

/**
 * `translated` with the link destinations and inline code of `source` put back in order, when
 * the engine kept as many of each; otherwise as the engine gave it.
 */
export function keepVerbatim(source: string, translated: string): string {
  let result = translated
  for (const pattern of [LINK_DESTINATION, INLINE_CODE]) {
    const originals = source.match(pattern) ?? []
    const found = result.match(pattern) ?? []
    if (originals.length === 0 || originals.length !== found.length) continue
    let index = 0
    result = result.replace(pattern, () => originals[index++]!)
  }
  return result
}

/**
 * Translates an announcement's title and Markdown text from one UI language into another with
 * the translator's default engine, in one request: the title first, then the text's prose. An
 * answer that does not line up (another count, or an empty piece where the text had words, which
 * is how the model engine answers when it lost count) throws `MisalignedTranslationError`.
 */
export async function translateAnnouncementText(
  text: AnnouncementTextDraft,
  from: Language,
  to: Language,
  translate: (request: TranslateRequest) => Promise<{ text: string[] }>
): Promise<AnnouncementTextDraft> {
  const body = splitMarkdown(text.body)
  const segments = [text.title.trim(), ...body.texts]
  const result = await translate({
    text: segments,
    source: TRANSLATOR_LANGUAGE[from],
    target: TRANSLATOR_LANGUAGE[to]
  })
  if (
    result.text.length !== segments.length ||
    result.text.some((translated, index) => segments[index]!.trim() && !translated.trim())
  ) {
    throw new MisalignedTranslationError()
  }
  const [title = '', ...lines] = result.text.map((translated, index) =>
    keepVerbatim(segments[index]!, translated)
  )
  return { title: title.trim(), body: joinTranslated(body.joints, lines) }
}
