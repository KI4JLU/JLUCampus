/**
 * Where a dashboard widget wants the transcription page to start: a view of the work area, or a
 * saved transcript. The component route has no search parameters, so the widget leaves the target
 * here before it navigates, and the page takes it once when it mounts (`WidgetTargetReceiver`).
 * It lives in memory only, never in the URL or storage.
 */
export type TranscriptionTarget =
  { view: 'choice' | 'upload' | 'record' | 'live' } | { transcriptId: string }

let pending: { componentId: string; target: TranscriptionTarget } | null = null

export function setTranscriptionTarget(componentId: string, target: TranscriptionTarget): void {
  pending = { componentId, target }
}

/** The target left for this component, once. */
export function takeTranscriptionTarget(componentId: string): TranscriptionTarget | null {
  const taken = pending
  pending = null
  return taken?.componentId === componentId ? taken.target : null
}
