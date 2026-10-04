/**
 * Result workspace (stream "result"): title and subtitle, the Preview, Corrections and Export tabs,
 * the global player, speaker blocks, corrections, redaction, undo, saving and AI optimisation
 * (T-22 to T-36). It publishes the open transcript with its edits as the workspace's
 * `currentDocument`, which the export and the summary read.
 */

/** The work area of the `result` view, for the workspace's `transcriptId`. */
export { ResultView } from './result-view'

/** The side column of the Preview and Corrections tabs: speakers, redactions, tools. */
export { ResultToolsPanel as ResultTools } from './tools'
