import {
  TRANSCRIPTION_EMPTY_SPEAKER_TEXT,
  type TranscriptionRedaction,
  type TranscriptionSegment,
  type TranscriptionSpeakerColorId,
  type TranscriptionSpeakerColorMap
} from '@justcampus/shared'
import { materializeSpeakers, type SpeakerBlock } from './blocks'
import { sanitizeSegmentText } from './text'

/**
 * The edits of the result workspace as pure functions over the segment list, after kiChat's
 * `SegmentProcessor` (T-27 to T-31). Each returns a new list, or `null` when there is nothing to
 * change, and never touches the decoder fields of segments it does not transform.
 */

/** Seconds an inserted speaker block lasts (T-30). */
export const INSERTED_BLOCK_SECONDS = 1

/** What kiChat offers to insert when a segment has no speaker. */
export const DEFAULT_INSERT_SPEAKER = 'Person 1'

/** The next free segment id. */
export function nextSegmentId(segments: readonly TranscriptionSegment[]): number {
  return segments.reduce((max, segment) => Math.max(max, segment.id), -1) + 1
}

/**
 * Corrects a segment's text (T-27): line breaks go, an empty text becomes the placeholder and
 * the segment's redactions are cleared, since their offsets no longer fit.
 */
export function updateSegmentText(
  segments: readonly TranscriptionSegment[],
  index: number,
  text: string
): TranscriptionSegment[] | null {
  const segment = segments[index]
  if (!segment) return null
  const sanitized = sanitizeSegmentText(text)
  if (segment.text === sanitized) return null
  const next = committedText(text)
  if (segment.text === next) return null
  const result = [...segments]
  result[index] = { ...segment, text: next, redactions: [] }
  return result
}

/** The text a correction stores for an editor's draft: without line breaks, or the placeholder. */
export function committedText(draft: string): string {
  const sanitized = sanitizeSegmentText(draft)
  return sanitized.trim() === '' ? TRANSCRIPTION_EMPTY_SPEAKER_TEXT : sanitized
}

/**
 * A selection made in the open editor (`start` to `end` of its `draft`), in the stored text of
 * its segment once the draft is committed (T-27, T-31, T-33): the line breaks a commit removes
 * no longer count. `null` when the segment no longer holds the committed draft, or nothing of the
 * selection is left in it.
 */
export function draftSelection(
  segments: readonly TranscriptionSegment[],
  segmentIndex: number,
  draft: string,
  start: number,
  end: number
): SelectionBounds | null {
  const text = committedText(draft)
  if (segments[segmentIndex]?.text !== text || text === TRANSCRIPTION_EMPTY_SPEAKER_TEXT) {
    return null
  }
  const committed = (offset: number): number =>
    sanitizeSegmentText(draft.slice(0, Math.max(0, offset))).length
  const from = committed(start)
  const to = Math.min(committed(end), text.length)
  return to > from
    ? { start: { segment: segmentIndex, offset: from }, end: { segment: segmentIndex, offset: to } }
    : null
}

export interface SpeakerChange {
  segments: TranscriptionSegment[]
  speakerColors: TranscriptionSpeakerColorMap
}

/**
 * Renames a speaker everywhere (T-28). Its colour moves to the new name unless that name has one
 * already (then the two speakers merge under it). Segments of `alsoSegments` (a block shown under
 * an automatic name) take the new name too.
 */
export function renameSpeaker(
  segments: readonly TranscriptionSegment[],
  speakerColors: TranscriptionSpeakerColorMap,
  oldName: string,
  newName: string,
  alsoSegments: readonly number[] = []
): SpeakerChange | null {
  const name = newName.trim()
  if (!name || name === oldName) return null
  const also = new Set(alsoSegments)
  let changed = false
  const result = segments.map((segment, index) => {
    if (segment.speaker === oldName || (also.has(index) && !segment.speaker)) {
      changed = true
      return { ...segment, speaker: name }
    }
    return segment
  })
  if (!changed) return null
  const colors = { ...speakerColors }
  const info = colors[oldName]
  if (info && !colors[name]) colors[name] = info
  delete colors[oldName]
  return { segments: result, speakerColors: colors }
}

/** Gives a speaker another of the ten colours (T-28). */
export function setSpeakerColor(
  speakerColors: TranscriptionSpeakerColorMap,
  speaker: string,
  colorId: TranscriptionSpeakerColorId
): TranscriptionSpeakerColorMap | null {
  const info = speakerColors[speaker]
  if (info?.colorId === colorId) return null
  const speakerIndex = info?.speakerIndex ?? Object.keys(speakerColors).length
  return { ...speakerColors, [speaker]: { colorId, speakerIndex } }
}

/** Assigns every segment of a block to a speaker, existing or new (T-29). */
export function reassignBlock(
  segments: readonly TranscriptionSegment[],
  block: SpeakerBlock,
  speaker: string
): TranscriptionSegment[] | null {
  const name = speaker.trim()
  if (!name) return null
  const result = [...segments]
  let changed = false
  for (const index of block.segmentIndices) {
    const segment = result[index]
    if (segment && segment.speaker !== name) {
      result[index] = { ...segment, speaker: name }
      changed = true
    }
  }
  return changed ? result : null
}

/**
 * Removes a block's speaker (T-29): its text goes to the block before, or after when it is the
 * first; its placeholders are dropped. The only block cannot be removed (`null`).
 */
export function removeBlockSpeaker(
  segments: readonly TranscriptionSegment[],
  blocks: readonly SpeakerBlock[],
  blockIndex: number
): TranscriptionSegment[] | null {
  const block = blocks[blockIndex]
  if (!block || blocks.length <= 1) return null
  const target = blockIndex > 0 ? blocks[blockIndex - 1]! : blocks[blockIndex + 1]!
  const explicit = materializeSpeakers(segments, blocks)
  const drop = new Set<number>()
  for (const index of block.segmentIndices) {
    const segment = explicit[index]!
    if (segment.text === TRANSCRIPTION_EMPTY_SPEAKER_TEXT) drop.add(index)
    else explicit[index] = { ...segment, speaker: target.speaker }
  }
  return explicit.filter((_, index) => !drop.has(index))
}

export type InsertPosition = 'above' | 'below'

/**
 * Inserts a block of a speaker before or after a block (T-30): one segment with the placeholder,
 * lasting a second from the boundary. Existing segments keep their text and times.
 */
export function insertSpeakerBlock(
  segments: readonly TranscriptionSegment[],
  blocks: readonly SpeakerBlock[],
  blockIndex: number,
  position: InsertPosition,
  speaker: string
): TranscriptionSegment[] | null {
  const block = blocks[blockIndex]
  const name = speaker.trim()
  if (!block || !name) return null
  const explicit = materializeSpeakers(segments, blocks)
  const first = block.segmentIndices[0]!
  const last = block.segmentIndices[block.segmentIndices.length - 1]!
  const at = position === 'above' ? first : last + 1
  const baseTime = position === 'above' ? explicit[first]!.start : explicit[last]!.end
  const inserted: TranscriptionSegment = {
    id: nextSegmentId(explicit),
    start: baseTime,
    end: baseTime + INSERTED_BLOCK_SECONDS,
    text: TRANSCRIPTION_EMPTY_SPEAKER_TEXT,
    speaker: name,
    redactions: [],
    avgLogprob: 0,
    noSpeechProb: 0,
    compressionRatio: 0
  }
  explicit.splice(at, 0, inserted)
  return explicit
}

/**
 * Drops placeholders that are no longer alone (kiChat's `cleanupOrphanedPlaceholders`): in a run
 * of one speaker with real text, every placeholder goes; a run of only placeholders keeps one.
 * `null` when there is none to drop.
 */
export function cleanupOrphanedPlaceholders(
  segments: readonly TranscriptionSegment[]
): TranscriptionSegment[] | null {
  const drop = new Set<number>()
  let start = 0
  const flush = (end: number): void => {
    const run = segments.slice(start, end)
    const hasText = run.some(
      (segment) => segment.text !== TRANSCRIPTION_EMPTY_SPEAKER_TEXT && segment.text.trim() !== ''
    )
    run.forEach((segment, offset) => {
      if (segment.text !== TRANSCRIPTION_EMPTY_SPEAKER_TEXT) return
      if (hasText || offset > 0) drop.add(start + offset)
    })
  }
  for (let index = 1; index <= segments.length; index++) {
    if (index === segments.length || segments[index]!.speaker !== segments[start]!.speaker) {
      flush(index)
      start = index
    }
  }
  return drop.size === 0 ? null : segments.filter((_, index) => !drop.has(index))
}

/**
 * The speakers of an AI optimisation applied to the segments as they are now (T-36). A segment
 * takes the answer's speaker for its id only while it is still the one that was sent (same text,
 * times and speaker); a segment the user changed meanwhile keeps the user's version. Text, timing,
 * redactions and decoder fields always stay the current ones. `null` when no speaker changes.
 */
export function applyOptimizedSpeakers(
  current: readonly TranscriptionSegment[],
  sent: readonly TranscriptionSegment[],
  answered: readonly Pick<TranscriptionSegment, 'id' | 'speaker'>[]
): TranscriptionSegment[] | null {
  const sentById = new Map(sent.map((segment) => [segment.id, segment]))
  const answers = new Map(answered.map((segment) => [segment.id, segment.speaker]))
  let changed = false
  const next = current.map((segment) => {
    const before = sentById.get(segment.id)
    const speaker = answers.get(segment.id)
    if (!before || speaker === undefined || speaker === segment.speaker) return segment
    const untouched =
      before === segment ||
      (before.text === segment.text &&
        before.start === segment.start &&
        before.end === segment.end &&
        before.speaker === segment.speaker)
    if (!untouched) return segment
    changed = true
    return { ...segment, speaker }
  })
  return changed ? next : null
}

/** The speakers a block can be assigned to: the others shown, in order (T-29). */
export function reassignOptions(blocks: readonly SpeakerBlock[], block: SpeakerBlock): string[] {
  return [...new Set(blocks.map((other) => other.speaker))].filter(
    (speaker) => speaker && speaker !== block.speaker
  )
}

/** The speakers that can be inserted next to a block: all others of the segments (T-30). */
export function insertOptions(
  segments: readonly TranscriptionSegment[],
  block: SpeakerBlock
): string[] {
  return [...new Set(segments.map((segment) => segment.speaker || DEFAULT_INSERT_SPEAKER))].filter(
    (speaker) => speaker && speaker !== block.speaker
  )
}

// ---------------------------------------------------------------------------
// Moving selected text to a neighbouring speaker (T-31)
// ---------------------------------------------------------------------------

/** A place in the text: segment index and character offset into its text. */
export interface TextPoint {
  segment: number
  offset: number
}

/** A text selection within one block, start before end. */
export interface SelectionBounds {
  start: TextPoint
  end: TextPoint
}

export type MoveDirection = 'up' | 'down'

/** Whether a selection names existing segments, lies in order and selects something. */
export function isValidSelection(
  segments: readonly TranscriptionSegment[],
  bounds: SelectionBounds | null
): bounds is SelectionBounds {
  if (!bounds) return false
  const { start, end } = bounds
  const first = segments[start.segment]
  const last = segments[end.segment]
  if (!first || !last) return false
  if (start.offset < 0 || start.offset > first.text.length) return false
  if (end.offset < 0 || end.offset > last.text.length) return false
  if (start.segment > end.segment) return false
  return start.segment < end.segment || start.offset < end.offset
}

/**
 * A selection with one edge moved to `point` (T-31, kiChat's touch handles): the other edge stays,
 * and the selection stays within its speaker block. `null` when the point lies outside the block
 * or the edges would meet or cross, so a drag never empties or turns the selection.
 */
export function moveSelectionEdge(
  segments: readonly TranscriptionSegment[],
  block: Pick<SpeakerBlock, 'segmentIndices'>,
  bounds: SelectionBounds,
  edge: 'start' | 'end',
  point: TextPoint
): SelectionBounds | null {
  if (!block.segmentIndices.includes(point.segment)) return null
  const next =
    edge === 'start' ? { start: point, end: bounds.end } : { start: bounds.start, end: point }
  return isValidSelection(segments, next) ? next : null
}

/**
 * The point one character before (`-1`) or after (`1`) `point` within a block, for moving a
 * selection edge with the arrow keys; over a segment boundary it moves into the neighbouring
 * segment. `null` at the block's start or end.
 */
export function stepTextPoint(
  segments: readonly TranscriptionSegment[],
  block: Pick<SpeakerBlock, 'segmentIndices'>,
  point: TextPoint,
  delta: -1 | 1
): TextPoint | null {
  const position = block.segmentIndices.indexOf(point.segment)
  const text = segments[point.segment]?.text
  if (position === -1 || text === undefined) return null
  const offset = point.offset + delta
  if (offset >= 0 && offset <= text.length) return { segment: point.segment, offset }
  const neighbour = block.segmentIndices[position + delta]
  const other = neighbour === undefined ? undefined : segments[neighbour]
  if (neighbour === undefined || !other) return null
  return delta > 0
    ? { segment: neighbour, offset: Math.min(1, other.text.length) }
    : { segment: neighbour, offset: Math.max(0, other.text.length - 1) }
}

/**
 * A valid selection without the segments it only touches: one starting at a segment's very end
 * starts at the next, one ending at a segment's very start ends at the one before. `null` for an
 * invalid selection.
 */
export function normalizeSelection(
  segments: readonly TranscriptionSegment[],
  bounds: SelectionBounds | null
): SelectionBounds | null {
  if (!isValidSelection(segments, bounds)) return null
  let { start, end } = bounds
  while (start.segment < end.segment && start.offset >= segments[start.segment]!.text.length) {
    start = { segment: start.segment + 1, offset: 0 }
  }
  while (end.segment > start.segment && end.offset === 0) {
    end = { segment: end.segment - 1, offset: segments[end.segment - 1]!.text.length }
  }
  const normalized = { start, end }
  return isValidSelection(segments, normalized) ? normalized : null
}

/** The speaker a selection would move to: the nearest other named one before or after it. */
export function moveTarget(
  segments: readonly TranscriptionSegment[],
  blocks: readonly SpeakerBlock[],
  bounds: SelectionBounds | null,
  direction: MoveDirection
): string | null {
  const selection = normalizeSelection(segments, bounds)
  if (!selection) return null
  const explicit = materializeSpeakers(segments, blocks)
  const current = explicit[selection.start.segment]!.speaker
  if (direction === 'up') {
    for (let index = selection.start.segment - 1; index >= 0; index--) {
      const speaker = explicit[index]!.speaker
      if (speaker && speaker !== current) return speaker
    }
  } else {
    for (let index = selection.end.segment + 1; index < explicit.length; index++) {
      const speaker = explicit[index]!.speaker
      if (speaker && speaker !== current) return speaker
    }
  }
  return null
}

/** The redactions of `[from, to)` of a text, moved to start at 0. */
function sliceRedactions(
  redactions: readonly TranscriptionRedaction[],
  from: number,
  to: number
): TranscriptionRedaction[] {
  const result: TranscriptionRedaction[] = []
  for (const range of redactions) {
    const start = Math.max(range.start, from)
    const end = Math.min(range.end, to)
    if (end > start) result.push({ start: start - from, end: end - from })
  }
  return result
}

/**
 * Splits a segment at a character offset, timing the parts in proportion to their length. The
 * second part gets `id`, the words after the split time and the redactions behind the offset; the
 * decoder fields stay on both, the token ids on the first.
 */
export function splitSegment(
  segment: TranscriptionSegment,
  offset: number,
  id: number
): [TranscriptionSegment, TranscriptionSegment] {
  const length = segment.text.length
  const splitTime = segment.start + (segment.end - segment.start) * (offset / length)
  const words = segment.words
  const first: TranscriptionSegment = {
    ...segment,
    text: segment.text.slice(0, offset),
    end: splitTime,
    redactions: sliceRedactions(segment.redactions, 0, offset)
  }
  const second: TranscriptionSegment = {
    ...segment,
    id,
    text: segment.text.slice(offset),
    start: splitTime,
    redactions: sliceRedactions(segment.redactions, offset, length)
  }
  delete second.tokens
  delete second.words
  if (words) {
    first.words = words.filter((word) => word.start < splitTime)
    second.words = words.filter((word) => word.start >= splitTime)
  }
  return [first, second]
}

/**
 * Moves the selected text to the neighbouring speaker before (`up`) or after (`down`) it: the
 * segments at the selection's edges are split where it starts and ends, and the selected part
 * changes speaker. This changes who said it, not the order. `null` when there is no valid
 * selection or no other speaker in that direction.
 */
export function moveSelection(
  segments: readonly TranscriptionSegment[],
  blocks: readonly SpeakerBlock[],
  bounds: SelectionBounds | null,
  direction: MoveDirection
): TranscriptionSegment[] | null {
  const selection = normalizeSelection(segments, bounds)
  const target = moveTarget(segments, blocks, selection, direction)
  if (!target || !selection) return null
  const result = materializeSpeakers(segments, blocks)
  let startIndex = selection.start.segment
  let endIndex = selection.end.segment

  // The end first, so the start's index stays valid.
  const endSegment = result[endIndex]!
  if (selection.end.offset > 0 && selection.end.offset < endSegment.text.length) {
    const [kept, rest] = splitSegment(endSegment, selection.end.offset, nextSegmentId(result))
    result.splice(endIndex, 1, kept, rest)
  }
  const startSegment = result[startIndex]!
  if (selection.start.offset > 0 && selection.start.offset < startSegment.text.length) {
    const [kept, moved] = splitSegment(startSegment, selection.start.offset, nextSegmentId(result))
    result.splice(startIndex, 1, kept, moved)
    startIndex += 1
    endIndex += 1
  }
  for (let index = startIndex; index <= endIndex; index++) {
    result[index] = { ...result[index]!, speaker: target }
  }
  return result
}
