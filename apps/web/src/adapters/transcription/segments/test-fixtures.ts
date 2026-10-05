import type { TranscriptionSegment } from '@justcampus/shared'

/** A segment for tests: id, times, text and speaker, no redactions. */
export function seg(
  id: number,
  start: number,
  end: number,
  text: string,
  speaker: string | null = null,
  extra: Partial<TranscriptionSegment> = {}
): TranscriptionSegment {
  return { id, start, end, text, speaker, redactions: [], ...extra }
}
