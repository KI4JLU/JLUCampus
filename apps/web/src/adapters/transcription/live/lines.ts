/** Subtitle width of the live transcript, kiChat's `LIVE_TRANSCRIPT_CHARS_PER_LINE`. */
export const LIVE_TRANSCRIPT_CHARS_PER_LINE = 42

/**
 * The rolling subtitle window of the live transcript (T-61): the line being written and at most
 * the two finished lines before it, oldest first. Older text is dropped, not hidden.
 */
export interface LiveTranscriptWindow {
  lines: readonly string[]
  current: string
}

export const EMPTY_LIVE_TRANSCRIPT_WINDOW: LiveTranscriptWindow = { lines: [], current: '' }

/**
 * Appends a chunk of transcript as kiChat's `appendLiveTranscriptText` does: while the current
 * line is longer than `LIVE_TRANSCRIPT_CHARS_PER_LINE`, it breaks at the last space within the
 * limit, else with a hard cut; the finished line loses its trailing spaces, the rest its leading
 * ones. Chunk by chunk, since where a chunk ends decides what gets trimmed.
 */
export function appendLiveTranscriptText(
  window: LiveTranscriptWindow,
  text: string
): LiveTranscriptWindow {
  if (!text) return window
  const limit = LIVE_TRANSCRIPT_CHARS_PER_LINE
  let lines = [...window.lines]
  let current = window.current + text
  while (current.length > limit) {
    let breakIndex = current.lastIndexOf(' ', limit)
    if (breakIndex <= 0) breakIndex = limit
    lines.push(current.slice(0, breakIndex).trimEnd())
    current = current.slice(breakIndex).trimStart()
  }
  if (lines.length > 2) lines = lines.slice(-2)
  return { lines, current }
}

/** The three rows to show, as kiChat's `renderLiveTranscriptWindow` fills them. */
export function liveTranscriptRows(window: LiveTranscriptWindow): {
  older: string
  prev: string
  current: string
} {
  const { lines } = window
  return {
    older: lines[lines.length - 2] ?? '',
    prev: lines[lines.length - 1] ?? '',
    current: window.current
  }
}
