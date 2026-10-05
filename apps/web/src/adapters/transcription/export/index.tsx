/**
 * Export (stream "export"): categories, formats and file names, DOCX, PDF, Markdown, text, SRT,
 * VTT and JSON, transcript formatting with presets and custom formats (T-41 to T-47). It works on
 * the workspace's `currentDocument`.
 */

/** The Export tab of the result workspace: what to export and its preview. */
export { ExportView } from './export-view'

/** The side column while the Export tab is shown: what to export, formatting, presets, speakers. */
export { ExportSettings } from './export-settings'
