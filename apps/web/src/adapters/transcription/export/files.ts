/**
 * What can be exported and how its files are named (T-41): a summary or the transcript as Word,
 * PDF, Markdown or text, subtitles as SubRip or WebVTT, the raw segments as JSON.
 */

export const EXPORT_CATEGORIES = ['summary', 'transcript', 'subtitles', 'json'] as const
export type ExportCategory = (typeof EXPORT_CATEGORIES)[number]

export const DOCUMENT_FORMATS = ['docx', 'pdf', 'markdown', 'txt'] as const
export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number]

export const SUBTITLE_FORMATS = ['srt', 'vtt'] as const
export type SubtitleFormat = (typeof SUBTITLE_FORMATS)[number]

export type ExportFormat = DocumentFormat | SubtitleFormat | 'json'

/** Summary and transcript start as Word, subtitles as SubRip; JSON has no choice. */
export const DEFAULT_DOCUMENT_FORMAT: DocumentFormat = 'docx'
export const DEFAULT_SUBTITLE_FORMAT: SubtitleFormat = 'srt'

/** The formats a category offers, in kiChat's order. */
export function formatsOf(category: ExportCategory): readonly ExportFormat[] {
  switch (category) {
    case 'summary':
    case 'transcript':
      return DOCUMENT_FORMATS
    case 'subtitles':
      return SUBTITLE_FORMATS
    case 'json':
      return ['json']
  }
}

/** The format's name on buttons (`Als DOCX herunterladen`). */
export const FORMAT_LABELS: Record<ExportFormat, string> = {
  docx: 'DOCX',
  pdf: 'PDF',
  markdown: 'Markdown',
  txt: 'TXT',
  srt: 'SRT',
  vtt: 'VTT',
  json: 'JSON'
}

export const FORMAT_EXTENSIONS: Record<ExportFormat, string> = {
  docx: 'docx',
  pdf: 'pdf',
  markdown: 'md',
  txt: 'txt',
  srt: 'srt',
  vtt: 'vtt',
  json: 'json'
}

/** The files' types; text is always UTF-8 (T-42). */
export const FORMAT_TYPES: Record<ExportFormat, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  markdown: 'text/markdown;charset=utf-8',
  txt: 'text/plain;charset=utf-8',
  srt: 'text/plain;charset=utf-8',
  vtt: 'text/vtt;charset=utf-8',
  json: 'application/json;charset=utf-8'
}

/** `transkription-<transcript>.<extension>`; without a saved transcript `transkription-export`. */
export function exportFilename(
  transcriptId: string | null | undefined,
  format: ExportFormat
): string {
  return `transkription-${transcriptId || 'export'}.${FORMAT_EXTENSIONS[format]}`
}

/** Saves a file through a temporary link, as the browser downloads it. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}
