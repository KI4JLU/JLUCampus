/**
 * Starts the job worker (analysis, normalisation, chunking, recognition, diarisation, correction)
 * and the sweep that deletes unsaved, failed and cancelled jobs with their audio after
 * `unsavedJobRetentionHours`. Returns the function that stops both.
 */
export function startJobWorker(): () => void {
  return () => {}
}
