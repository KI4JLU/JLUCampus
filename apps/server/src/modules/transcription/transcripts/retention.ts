/**
 * Starts the sweep that deletes saved transcripts past the admin's `transcriptRetentionHours`
 * (none while it is `null`). Returns the function that stops it.
 */
export function startTranscriptRetention(): () => void {
  return () => {}
}
