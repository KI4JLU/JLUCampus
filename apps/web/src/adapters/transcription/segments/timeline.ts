import type { TranscriptionSourceFile, TranscriptionSpeakerColorId } from '@justcampus/shared'
import type { SpeakerBlock } from './blocks'

/**
 * Global time of a transcript made of several files (T-14, T-24): each source file covers
 * `[startTime, endTime)` of the transcript's time line, and its audio plays at the local time
 * `global - startTime`.
 */

/** The source playing at a global time: the one whose range holds it, else the last. */
export function sourceIndexAt(sources: readonly TranscriptionSourceFile[], time: number): number {
  if (sources.length === 0) return -1
  const index = sources.findIndex((source) => time >= source.startTime && time < source.endTime)
  return index === -1 ? sources.length - 1 : index
}

/** The local time within a source, never below 0. */
export function toLocalTime(source: TranscriptionSourceFile, time: number): number {
  return Math.max(0, time - source.startTime)
}

/** The global time of a local time within a source. */
export function toGlobalTime(source: TranscriptionSourceFile, local: number): number {
  return source.startTime + local
}

/** Seconds the whole transcript lasts: the last source's end, else the last block's end. */
export function totalDuration(
  sources: readonly TranscriptionSourceFile[],
  blocks: readonly SpeakerBlock[],
  fallback: number | null
): number {
  const last = sources[sources.length - 1]
  if (last) return last.endTime
  return fallback ?? blocks[blocks.length - 1]?.end ?? 0
}

export interface TimelineStretch {
  start: number
  end: number
  colorId: TranscriptionSpeakerColorId | null
}

/**
 * The speaker time line of one source, in its local time: the blocks that overlap it, clipped to
 * its range. Without a source the blocks as they are.
 */
export function sourceTimeline(
  blocks: readonly SpeakerBlock[],
  source: TranscriptionSourceFile | null
): TimelineStretch[] {
  if (!source) return blocks.map(({ start, end, colorId }) => ({ start, end, colorId }))
  const stretches: TimelineStretch[] = []
  for (const block of blocks) {
    const start = Math.max(block.start, source.startTime)
    const end = Math.min(block.end, source.endTime)
    if (end > start) {
      stretches.push({
        start: start - source.startTime,
        end: end - source.startTime,
        colorId: block.colorId
      })
    }
  }
  return stretches
}

/** What continuous playback does next; `time` is the global time to show. */
export type PlaybackStep =
  | { kind: 'play'; time: number }
  /** `last`: the end of the last source, not of a block. */
  | { kind: 'stop'; time: number; last: boolean }
  | { kind: 'next'; index: number; local: number; time: number }

/**
 * Continuous playback over the saved ranges of several sources (T-24, kiChat's
 * `handleTimeUpdate`): the time shown never passes the playing source's `endTime`, which is where
 * the next source takes over, even when the file's audio runs longer (trailing silence); the last
 * source stops there. `end` is the global end of a block being played (Corrections), carried
 * across sources; playback stops when it is crossed (`previous` before it, `local` at or after
 * it), so a seek past it does not stop playback. `previous` is the global time last shown.
 */
export function playbackStep(
  sources: readonly TranscriptionSourceFile[],
  index: number,
  local: number,
  end: number | null,
  previous: number | null
): PlaybackStep {
  const source = sources[index]
  if (!source) return { kind: 'play', time: local }
  const global = toGlobalTime(source, local)
  const bounded = source.endTime > source.startTime
  const time = bounded ? Math.min(global, source.endTime) : global
  if (end !== null && global >= end && (previous === null || previous < end)) {
    return { kind: 'stop', time: Math.min(time, end), last: false }
  }
  if (bounded && global >= source.endTime) {
    const next = sources[index + 1]
    return next
      ? { kind: 'next', index: index + 1, local: toLocalTime(next, source.endTime), time }
      : { kind: 'stop', time, last: true }
  }
  return { kind: 'play', time }
}
