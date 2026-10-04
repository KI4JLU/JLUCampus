/**
 * Word and PDF files made in the browser from the export's text, ported from kiChat's
 * `generateDocxBlob` and `generatePdfBlob` (T-42), and the plain text of a Markdown summary.
 * A summary is Markdown and brings its own headings; the transcript is the running record, which
 * gets its title on top and bold speaker lines. Tables stay as their pipe text in both files.
 */

/** A piece of a line with its inline formatting. */
export interface InlineRun {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  code?: boolean
}

/** `**bold**`, `*italic*`, `__underline__` and `` `code` `` of one line, as kiChat splits it. */
export function parseInlineMarkdown(text: string): InlineRun[] {
  if (!text) return []
  return text
    .split(/(\*\*.*?\*\*|\*.*?\*|__.*?__|`.*?`)/g)
    .map((part): InlineRun => {
      if (part.length >= 4 && part.startsWith('**') && part.endsWith('**'))
        return { text: part.slice(2, -2), bold: true }
      if (part.length >= 2 && part.startsWith('*') && part.endsWith('*'))
        return { text: part.slice(1, -1), italic: true }
      if (part.length >= 4 && part.startsWith('__') && part.endsWith('__'))
        return { text: part.slice(2, -2), underline: true }
      if (part.length >= 2 && part.startsWith('`') && part.endsWith('`'))
        return { text: part.slice(1, -1), code: true }
      return { text: part }
    })
    .filter((run) => run.text.length > 0)
}

/** A line without its inline Markdown signs, as kiChat's PDF writes it. */
export function stripInlineMarkdown(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
}

/** A speaker or section line of the running record (`[00:00:00] Name:`), set bold. */
const RECORD_HEADING = /^(\[\d{1,2}:\d{2}(:\d{2})?\])?\s*[^:\n]+:$/

/** What a line of the text is, as both files read it. */
interface Line {
  text: string
  /** 0 for body text, 1 to 3 for Markdown headings; record headings count as 3. */
  heading: number
  bullet: boolean
  /** `3.` of a numbered item. */
  number: string | null
}

function readLine(raw: string, markdown: boolean): Line | null {
  let text = raw.trim()
  if (!text) return null
  if (!markdown)
    return { text, heading: RECORD_HEADING.test(text) ? 3 : 0, bullet: false, number: null }
  for (const level of [1, 2, 3]) {
    const sign = `${'#'.repeat(level)} `
    if (text.startsWith(sign))
      return { text: text.slice(sign.length), heading: level, bullet: false, number: null }
  }
  if (text.startsWith('- ') || text.startsWith('* ') || text.startsWith('• '))
    return { text: text.slice(2), heading: 0, bullet: true, number: null }
  const numbered = /^(\d+\.)\s/.exec(text)
  if (numbered) {
    text = text.slice(numbered[0].length)
    return { text, heading: 0, bullet: false, number: numbered[1]! }
  }
  return { text, heading: 0, bullet: false, number: null }
}

/**
 * The Word file: H1 to H3 at 18, 14 and 12 pt, body at 12 pt, inline bold, italic, underline and
 * monospace, bullets and numbers in front of list items. Non-Markdown text gets `title` as an
 * 18 pt bold first paragraph.
 */
export async function documentDocx(
  content: string,
  title: string,
  markdown: boolean
): Promise<Blob> {
  const docx = await import('docx')
  const children: InstanceType<typeof docx.Paragraph>[] = []
  if (!markdown && title) {
    children.push(
      new docx.Paragraph({
        children: [new docx.TextRun({ text: title, bold: true, size: 36 })],
        spacing: { after: 300 }
      })
    )
  }
  for (const raw of content.split('\n')) {
    const line = readLine(raw, markdown)
    if (!line) {
      children.push(new docx.Paragraph({ children: [], spacing: { after: 120 } }))
      continue
    }
    const size = line.heading === 1 ? 36 : line.heading === 2 ? 28 : 24
    const runs = (markdown ? parseInlineMarkdown(line.text) : [{ text: line.text }]).map(
      (part: InlineRun) =>
        new docx.TextRun({
          text: part.text,
          bold: Boolean(part.bold) || line.heading > 0,
          italics: Boolean(part.italic),
          underline: part.underline ? { type: docx.UnderlineType.SINGLE } : undefined,
          font: part.code ? 'Courier New' : undefined,
          size
        })
    )
    if (line.bullet) runs.unshift(new docx.TextRun({ text: '• ', size: 24 }))
    else if (line.number)
      runs.unshift(new docx.TextRun({ text: `${line.number} `, bold: true, size: 24 }))
    children.push(
      new docx.Paragraph({ children: runs, spacing: { after: line.heading > 0 ? 200 : 120 } })
    )
  }
  const file = new docx.Document({
    sections: [{ properties: { type: docx.SectionType.CONTINUOUS }, children }]
  })
  return docx.Packer.toBlob(file)
}

/**
 * The PDF: A4 in Helvetica with 20 mm margins, headings at 18, 14 and 12 pt, body at 11 pt, lines
 * wrapped to the width and a new page before 270 mm. Inline Markdown signs are dropped.
 * Non-Markdown text gets `title` in 16 pt bold over a grey rule.
 */
export async function documentPdf(
  content: string,
  title: string,
  markdown: boolean
): Promise<Blob> {
  const { jsPDF } = await import('jspdf')
  const pdf = new jsPDF()
  const maxPageHeight = 270
  const margin = 20
  const maxWidth = 210 - margin * 2
  const font = 'helvetica'
  let y = 20

  if (!markdown && title) {
    pdf.setFont(font, 'bold')
    pdf.setFontSize(16)
    pdf.text(title, margin, y)
    // The rule's grey belongs to the printed page, not to the app's theme.
    pdf.setDrawColor(200, 200, 200)
    pdf.line(margin, y + 3, 210 - margin, y + 3)
    y += 12
  }

  for (const raw of content.split('\n')) {
    const line = readLine(raw, markdown)
    if (!line) {
      y += 6
      continue
    }
    let text = line.text
    let size = 11
    let style = 'normal'
    if (markdown) {
      if (line.heading > 0) {
        size = [18, 14, 12][line.heading - 1]!
        style = 'bold'
      } else if (line.bullet) text = `• ${text}`
      else if (line.number) text = `${line.number} ${text}`
      text = stripInlineMarkdown(text)
    } else if (line.heading > 0) style = 'bold'

    pdf.setFont(font, style)
    pdf.setFontSize(size)
    const lineHeight = pdf.getLineHeight() / pdf.internal.scaleFactor || 6
    for (const wrapped of pdf.splitTextToSize(text, maxWidth) as string[]) {
      if (y + lineHeight > maxPageHeight) {
        pdf.addPage()
        y = 20
      }
      pdf.text(wrapped, margin, y)
      y += lineHeight
    }
    y += markdown && line.heading > 0 ? 4 : 2
  }
  return pdf.output('blob')
}

/** The kind of a Markdown block, for the plain text's line breaks. */
type PlainBlock = { kind: 'paragraph' | 'line'; text: string }

function cellsOf(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => stripInlineMarkdown(cell.trim()))
}

/**
 * A Markdown summary as its preview reads as plain text, which is what kiChat copies and saves as
 * `.txt`: without heading, list, quote and emphasis signs, rules left out, table cells apart by
 * tabs. Paragraphs stand between blank lines, other blocks on lines of their own.
 */
export function markdownPlainText(markdown: string): string {
  const blocks: PlainBlock[] = []
  let paragraph: string[] = []
  let table: string[] | null = null
  const flushParagraph = (): void => {
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', text: paragraph.join(' ') })
    paragraph = []
  }
  const flushTable = (): void => {
    if (table && table.length > 0) blocks.push({ kind: 'line', text: table.join('\n') })
    table = null
  }

  for (const raw of markdown.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('|')) {
      flushParagraph()
      // The row of dashes under the head is no row of the table.
      if (/^\|?[\s:|-]+\|?$/.test(line) && line.includes('-')) continue
      table ??= []
      table.push(cellsOf(line).join('\t'))
      continue
    }
    flushTable()
    if (!line) {
      flushParagraph()
      continue
    }
    if (/^([-*_])(\s*\1){2,}$/.test(line)) {
      flushParagraph()
      continue
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (heading) {
      flushParagraph()
      blocks.push({ kind: 'line', text: stripInlineMarkdown(heading[1]!) })
      continue
    }
    const item = /^(?:[-*+•]|\d+[.)])\s+(.*)$/.exec(line)
    if (item) {
      flushParagraph()
      blocks.push({ kind: 'line', text: stripInlineMarkdown(item[1]!) })
      continue
    }
    const quote = /^>\s?(.*)$/.exec(line)
    paragraph.push(stripInlineMarkdown(quote ? quote[1]! : line))
  }
  flushParagraph()
  flushTable()

  let text = ''
  blocks.forEach((block, index) => {
    if (index > 0) {
      const previous = blocks[index - 1]!
      text += previous.kind === 'paragraph' || block.kind === 'paragraph' ? '\n\n' : '\n'
    }
    text += block.text
  })
  return text
}
