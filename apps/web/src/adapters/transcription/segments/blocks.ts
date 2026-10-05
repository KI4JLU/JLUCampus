import type {
  TranscriptionSegment,
  TranscriptionSpeakerColorId,
  TranscriptionSpeakerColorMap
} from '@justcampus/shared'
import { joinTexts } from './text'

/**
 * Speaker blocks, after kiChat's `formatTranscriptionWithSpeakers` (T-25): consecutive segments of
 * one named speaker form a block. Segments without a speaker continue the block before them until
 * a pause of more than three seconds or a block longer than 45 seconds; each such stretch is a
 * speaker of its own, `Unbekannt 1`, `Unbekannt 2`, … in kiChat's (German) spelling, which the web
 * app shows localised.
 */

/** The stored name of the n-th stretch without a speaker. */
export const UNKNOWN_SPEAKER_PREFIX = 'Unbekannt'
const UNKNOWN_SPEAKER = /^Unbekannt (\d+)$/

/** Seconds of silence after which segments without a speaker start a new block. */
export const UNKNOWN_SPEAKER_GAP_SECONDS = 3
/** Seconds after which a block of segments without a speaker is cut. */
export const UNKNOWN_SPEAKER_SPAN_SECONDS = 45

export interface SpeakerBlock {
  index: number
  /** The speaker's name; for a stretch without a speaker `Unbekannt <n>`. */
  speaker: string
  /** `n` of `Unbekannt <n>`, also when that name was stored on the segments; else `null`. */
  unknown: number | null
  colorId: TranscriptionSpeakerColorId
  /** Start of the first segment, end of the last. */
  start: number
  end: number
  /** Indices into the segment list, ascending. */
  segmentIndices: number[]
  /** The block's text as kiChat joins it. */
  text: string
}

/** `n` when the name is kiChat's automatic `Unbekannt <n>`, else `null`. */
export function unknownSpeakerNumber(name: string): number | null {
  const match = UNKNOWN_SPEAKER.exec(name)
  return match ? Number(match[1]) : null
}

/** The colour a new speaker gets: by its order of appearance, cycling through ten (T-25). */
function nextColor(colors: TranscriptionSpeakerColorMap): {
  colorId: TranscriptionSpeakerColorId
  speakerIndex: number
} {
  const size = Object.keys(colors).length
  return { colorId: ((size % 10) + 1) as TranscriptionSpeakerColorId, speakerIndex: size }
}

export interface SpeakerBlocks {
  blocks: SpeakerBlock[]
  /**
   * The colours with an entry for every speaker shown; the same object when nothing was added, so
   * it can be compared to decide whether there is something to save.
   */
  speakerColors: TranscriptionSpeakerColorMap
}

/** Groups the segments into speaker blocks and gives speakers without a colour the next one. */
export function buildSpeakerBlocks(
  segments: readonly TranscriptionSegment[],
  speakerColors: TranscriptionSpeakerColorMap
): SpeakerBlocks {
  let colors = speakerColors
  const blocks: SpeakerBlock[] = []
  let current: Omit<SpeakerBlock, 'text'> | null = null
  let texts: string[] = []
  let unknownCounter = 1
  let lastEnd = 0

  const finish = (): void => {
    if (current) blocks.push({ ...current, text: joinTexts(texts) })
  }

  segments.forEach((segment, index) => {
    const pause = segment.start - lastEnd
    const named = segment.speaker || null
    const change = named
      ? current !== null && current.speaker !== named
      : index > 0 &&
        (pause > UNKNOWN_SPEAKER_GAP_SECONDS ||
          segment.start - (current ? current.start : 0) > UNKNOWN_SPEAKER_SPAN_SECONDS)

    if (index === 0 || change || !current) {
      finish()
      let speaker = named
      if (!speaker) {
        speaker = `${UNKNOWN_SPEAKER_PREFIX} ${unknownCounter}`
        unknownCounter++
      }
      if (!colors[speaker]) colors = { ...colors, [speaker]: nextColor(colors) }
      current = {
        index: blocks.length,
        speaker,
        unknown: unknownSpeakerNumber(speaker),
        colorId: colors[speaker]!.colorId,
        start: segment.start,
        end: segment.end,
        segmentIndices: [index]
      }
      texts = [segment.text]
    } else {
      current.segmentIndices.push(index)
      current.end = segment.end
      texts.push(segment.text)
    }
    lastEnd = segment.end
  })
  finish()
  return { blocks, speakerColors: colors }
}

export interface BlockSpeaker {
  speaker: string
  unknown: number | null
  colorId: TranscriptionSpeakerColorId
  /** The first block of this speaker. */
  firstBlock: number
}

/** The speakers of the blocks, each once, in order of appearance (the speaker panel, T-26). */
export function blockSpeakers(blocks: readonly SpeakerBlock[]): BlockSpeaker[] {
  const seen = new Map<string, BlockSpeaker>()
  for (const block of blocks) {
    if (!seen.has(block.speaker)) {
      seen.set(block.speaker, {
        speaker: block.speaker,
        unknown: block.unknown,
        colorId: block.colorId,
        firstBlock: block.index
      })
    }
  }
  return [...seen.values()]
}

/** The block playing at a time: the first whose span holds it, else -1 (T-24). */
export function blockAt(blocks: readonly SpeakerBlock[], time: number): number {
  return blocks.findIndex((block) => time >= block.start && time < block.end)
}

/**
 * Writes every block's speaker onto its segments that have none, as kiChat does before a
 * structural change, so a change of blocks does not regroup the stretches without a speaker.
 */
export function materializeSpeakers(
  segments: readonly TranscriptionSegment[],
  blocks: readonly SpeakerBlock[]
): TranscriptionSegment[] {
  const result = [...segments]
  for (const block of blocks) {
    for (const index of block.segmentIndices) {
      const segment = result[index]
      if (segment && !segment.speaker) result[index] = { ...segment, speaker: block.speaker }
    }
  }
  return result
}

/** Whether only `speaker` is shown while there are others (kiChat's solo, T-26). */
export function isSoloed(
  speakers: readonly string[],
  hidden: ReadonlySet<string>,
  speaker: string
): boolean {
  return (
    speakers.length > 1 &&
    !hidden.has(speaker) &&
    speakers.every((other) => other === speaker || hidden.has(other))
  )
}

/**
 * What the speaker panel shows when a speaker is chosen to focus (T-26): a hidden speaker (by the
 * eye or by another's solo, which may still be set from the Preview) is shown again, so the
 * focused blocks can be seen and scrolled to; everyone else stays as they are. The same set when
 * the speaker is shown already.
 */
export function revealSpeaker(hidden: ReadonlySet<string>, speaker: string): ReadonlySet<string> {
  if (!hidden.has(speaker)) return hidden
  const next = new Set(hidden)
  next.delete(speaker)
  return next
}

/** Shows only `speaker`, or everyone again when it is already the only one shown. */
export function toggleSolo(
  speakers: readonly string[],
  hidden: ReadonlySet<string>,
  speaker: string
): Set<string> {
  if (isSoloed(speakers, hidden, speaker)) return new Set()
  return new Set(speakers.filter((other) => other !== speaker))
}
