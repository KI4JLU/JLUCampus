import {
  TRANSCRIPTION_UNDO_MAX,
  type TranscriptionSegment,
  type TranscriptionSpeakerColorMap
} from '@justcampus/shared'

/**
 * The undo stack of the result workspace (T-34): up to ten snapshots taken before structural
 * changes (speakers, insertions, moves, redactions, AI optimisation), kept in memory only. Text
 * corrections take none, as in kiChat; there is no redo.
 */

export interface EditSnapshot {
  segments: readonly TranscriptionSegment[]
  speakerColors: TranscriptionSpeakerColorMap
}

/** The stack with `snapshot` on top, the oldest dropped beyond the limit. */
export function pushUndo(
  stack: readonly EditSnapshot[],
  snapshot: EditSnapshot,
  limit: number = TRANSCRIPTION_UNDO_MAX
): EditSnapshot[] {
  const next = [...stack, snapshot]
  return next.length > limit ? next.slice(next.length - limit) : next
}

/** The stack without its top, and the top; `null` for an empty stack. */
export function popUndo(
  stack: readonly EditSnapshot[]
): { stack: EditSnapshot[]; snapshot: EditSnapshot } | null {
  const snapshot = stack[stack.length - 1]
  if (!snapshot) return null
  return { stack: stack.slice(0, -1), snapshot }
}
