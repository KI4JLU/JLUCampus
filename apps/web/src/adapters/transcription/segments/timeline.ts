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
