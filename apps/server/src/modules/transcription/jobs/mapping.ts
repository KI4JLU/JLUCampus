import {
  TRANSCRIPTION_SEGMENT_TEXT_MAX,
  TRANSCRIPTION_SPEAKER_NAME_MAX,
  type TranscriptionSegment,
  type TranscriptionWord
} from '@justcampus/shared'

import type { DiarizationTurn, SpeechRegion } from './diarization.js'

/**
 * kiChat's time-overlap speaker mapping (`CustomSpeachesProvider::mapDiarizationSegments`),
 * ported rule for rule:
 *
 * 1. With word timing, words are grouped into phrases (a pause of 0.25 s, or of 0.10 s after
 *    sentence punctuation or at a change of voice, starts a new one). Each phrase goes to the voice
 *    its words overlap most, later words weighing up to twice as much; a phrase no voice overlaps
 *    takes the voice nearest to its middle within the VAD region it lies in.
 * 2. The words are spread over the recognised segments (by their middle, else the nearest). A
 *    segment with words is split where the voice changes or a sentence ends with a pause; a word
 *    still without voice takes the turn around its middle, else the one it overlaps most, else
 *    the VAD fallback. A segment without words goes whole to the voice overlapping it most.
 * 3. Voices are named: a diarised id the user named (`speaker_mapping`) gets that name, a name the
 *    diariser recognised (`known_speaker_names`) stays, any other voice becomes the next
 *    `Stimme N`. Speech no voice covers is `Unbekannt`, which is `null` here.
 * 4. Neighbouring segments of one voice less than 3 s apart are merged, unless the first ends a
 *    sentence and a pause of 0.10 s follows; segments are numbered from 1 again.
 *
 * Segments keep their decoder fields (a split part inherits its parent's). Words carry the name
 * of their voice too; segments carry no word lists, as the result keeps the words apart.
 */

/** kiChat's label for speech no voice covers. */
const UNKNOWN = 'Unbekannt'

/** The characters kiChat trims before looking at a word's last character. */
const QUOTES = ' \t\n\r\0\x0B"\'»«›‹„“'
const SENTENCE_END = new Set(['.', '?', '!', ':', ';'])

/** Whether a text ends a sentence, quotes and spaces aside (kiChat's `$endsWithPunctuation`). */
export function endsWithPunctuation(text: string): boolean {
  let end = text.length
  while (end > 0 && QUOTES.includes(text[end - 1]!)) end--
  let start = 0
  while (start < end && QUOTES.includes(text[start]!)) start++
  return end > start && SENTENCE_END.has(text[end - 1]!)
}

interface Span {
  start: number
  end: number
}

interface MappedWord extends TranscriptionWord {
  speaker?: string | null
}

type Segment = TranscriptionSegment & { words?: MappedWord[] }

export interface MappingOptions {
  /** The VAD's speech regions, for the gap filling. */
  vadSegments?: readonly SpeechRegion[]
  /** Diarised id → the name the user gave (kiChat's `speaker_mapping`). */
  speakerMapping?: Readonly<Record<string, string>>
  /** The names sent as known voices. */
  knownSpeakerNames?: readonly string[]
}

function overlapOf(a: Span, b: Span): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start))
}

/** The voice a single word overlaps most (kiChat's `getWordSpeaker`). */
function wordSpeaker(word: Span, turns: readonly DiarizationTurn[]): string | null {
  let best: string | null = null
  let most = 0
  for (const turn of turns) {
    const value = overlapOf(word, turn)
    if (value > most) {
      most = value
      best = turn.speaker
    }
  }
  return best
}

/** The key with the largest value, the first of equals (PHP's stable `arsort`). */
function largest(values: ReadonlyMap<string, number>): string | null {
  let best: string | null = null
  let most = Number.NEGATIVE_INFINITY
  for (const [key, value] of values) {
    if (value > most) {
      most = value
      best = key
    }
  }
  return best
}

/**
 * The VAD gap filling: within the speech region around `middle`, the voice of the turn nearest to
 * it among those overlapping the region; `null` without one.
 */
function vadSpeaker(
  middle: number,
  vad: readonly SpeechRegion[],
  turns: readonly DiarizationTurn[]
): string | null {
  const region = vad.find((candidate) => middle >= candidate.start && middle <= candidate.end)
  if (!region) return null
  let best: string | null = null
  let nearest: number | null = null
  for (const turn of turns) {
    if (Math.min(region.end, turn.end) <= Math.max(region.start, turn.start)) continue
    const distance =
      middle < turn.start ? turn.start - middle : middle > turn.end ? middle - turn.end : 0
    if (nearest === null || distance < nearest) {
      nearest = distance
      best = turn.speaker
    }
  }
  return best
}

/** Step 1: the phrases of the words and the voice of each word. */
function assignPhrases(
  words: readonly MappedWord[],
  turns: readonly DiarizationTurn[],
  vad: readonly SpeechRegion[]
): MappedWord[] {
  const phrases: MappedWord[][] = []
  let current: MappedWord[] = []
  for (const word of words) {
    if (current.length === 0) {
      current.push(word)
      continue
    }
    const previous = current[current.length - 1]!
    const gap = word.start - previous.end
    const before = wordSpeaker(previous, turns)
    const now = wordSpeaker(word, turns)
    const changed = before !== null && now !== null && before !== now
    const punctuation = endsWithPunctuation(previous.word)
    const split =
      gap >= 0.25 || (changed && (gap >= 0.1 || punctuation)) || (punctuation && gap >= 0.1)
    if (split) {
      phrases.push(current)
      current = [word]
    } else current.push(word)
  }
  if (current.length > 0) phrases.push(current)

  const assigned: MappedWord[] = []
  for (const phrase of phrases) {
    const overlaps = new Map<string, number>()
    const count = phrase.length
    phrase.forEach((word, index) => {
      const weight = 1 + (count > 1 ? index / (count - 1) : 0)
      const duration = Math.max(0.01, word.end - word.start)
      for (const turn of turns) {
        const value = overlapOf(word, turn)
        if (value > 0) {
          overlaps.set(
            turn.speaker,
            (overlaps.get(turn.speaker) ?? 0) + value * (value / duration) * weight
          )
        }
      }
    })
    let best = largest(overlaps)
    if ((!best || best === UNKNOWN) && vad.length > 0) {
      const middle = (phrase[0]!.start + phrase[count - 1]!.end) / 2
      best = vadSpeaker(middle, vad, turns) ?? best
    }
    const speaker = best || UNKNOWN
    for (const word of phrase) assigned.push({ ...word, speaker })
  }
  return assigned
}

/** Step 3's naming, which hands out `Stimme N` in the order voices first appear. */
function namer(options: MappingOptions): (speaker: string | null) => string {
  const mapping = new Map<string, string>()
  for (const [id, name] of Object.entries(options.speakerMapping ?? {})) {
    if (name.trim()) mapping.set(id, name.trim())
  }
  const known = new Set(options.knownSpeakerNames ?? [])
  let next = mapping.size + 1
  for (const name of mapping.values()) {
    // kiChat only looks for `Sprecher N`; its own labels are `Stimme N`, so both count here.
    const match = /(?:Sprecher|Stimme)\s+(\d+)/i.exec(name)
    if (match && Number(match[1]) >= next) next = Number(match[1]) + 1
  }
  const names = new Set(mapping.values())
  return (speaker) => {
    if (!speaker || speaker === UNKNOWN) return UNKNOWN
    const mapped = mapping.get(speaker)
    if (mapped !== undefined) return mapped
    if (names.has(speaker) || known.has(speaker)) return speaker
    const label = `Stimme ${next++}`
    mapping.set(speaker, label)
    return label
  }
}

/** Step 2 for one word without a voice yet. */
function fillWord(
  word: MappedWord,
  turns: readonly DiarizationTurn[],
  vad: readonly SpeechRegion[]
): string {
  const middle = (word.start + word.end) / 2
  let speaker = word.speaker ?? null
  if (!speaker || speaker === UNKNOWN) {
    const around = turns.find((turn) => middle >= turn.start && middle <= turn.end)
    if (around) speaker = around.speaker
    if (!speaker) {
      let most = 0
      for (const turn of turns) {
        const value = overlapOf(word, turn)
        if (value > most) {
          most = value
          speaker = turn.speaker
        }
      }
    }
    if ((!speaker || speaker === UNKNOWN) && vad.length > 0) {
      speaker = vadSpeaker(middle, vad, turns) ?? speaker
    }
  }
  return speaker || UNKNOWN
}

/** The words of each segment: those whose middle lies in it, else in the nearest one. */
function wordsPerSegment(
  segments: readonly Segment[],
  words: readonly MappedWord[]
): Map<number, MappedWord[]> {
  const map = new Map<number, MappedWord[]>()
  for (const word of words) {
    const middle = (word.start + word.end) / 2
    let found = segments.findIndex((segment) => middle >= segment.start && middle <= segment.end)
    if (found < 0) {
      let nearest: number | null = null
      segments.forEach((segment, index) => {
        const distance = Math.min(Math.abs(middle - segment.start), Math.abs(middle - segment.end))
        if (nearest === null || distance < nearest) {
          nearest = distance
          found = index
        }
      })
    }
    if (found >= 0) {
      const list = map.get(found) ?? []
      list.push(word)
      map.set(found, list)
    }
  }
  return map
}

/**
 * The text of words as kiChat concatenates them: Whisper's words carry their leading space. Words
 * without any (OpenAI's word timing) are joined with spaces instead.
 */
export function joinWords(words: readonly Pick<TranscriptionWord, 'word'>[]): string {
  const spaced = words.some((word) => /^\s/.test(word.word))
  return words
    .map((word) => (spaced ? word.word : word.word.trim()))
    .join(spaced ? '' : ' ')
    .trim()
}

function withoutWords(segment: Segment): TranscriptionSegment {
  const rest = { ...segment }
  delete rest.words
  return rest
}

function publicName(name: string): string | null {
  return name === UNKNOWN ? null : name.slice(0, TRANSCRIPTION_SPEAKER_NAME_MAX)
}

/**
 * Names the segments and words of a recognition by diarised turns, as kiChat does. Without turns
 * nothing changes.
 */
export function mapDiarizationSegments(
  result: { segments: readonly TranscriptionSegment[]; words: readonly TranscriptionWord[] },
  turns: readonly DiarizationTurn[],
  options: MappingOptions = {}
): { segments: TranscriptionSegment[]; words: TranscriptionWord[] } {
  if (turns.length === 0) {
    return { segments: [...result.segments], words: [...result.words] }
  }
  const vad = options.vadSegments ?? []
  const segments = result.segments as readonly Segment[]
  const words = result.words.length > 0 ? assignPhrases(result.words, turns, vad) : []
  const name = namer(options)
  const perSegment = wordsPerSegment(segments, words)

  const split: Segment[] = []
  segments.forEach((parent, index) => {
    const own = parent.words ?? perSegment.get(index) ?? []
    if (own.length > 0) {
      const voiced = own.map((word) => ({ ...word, speaker: fillWord(word, turns, vad) }))
      const groups: Array<{ speaker: string; words: MappedWord[] }> = []
      for (const word of voiced) {
        const group = groups[groups.length - 1]
        if (group) {
          const previous = group.words[group.words.length - 1]!
          const pause = endsWithPunctuation(previous.word) && word.start - previous.end >= 0.1
          if (group.speaker === word.speaker && !pause) {
            group.words.push(word)
            continue
          }
        }
        groups.push({ speaker: word.speaker, words: [word] })
      }
      for (const group of groups) {
        split.push({
          ...parent,
          start: group.words[0]!.start,
          end: group.words[group.words.length - 1]!.end,
          text: joinWords(group.words),
          speaker: name(group.speaker),
          words: group.words
        })
      }
      return
    }
    const overlaps = new Map<string, number>()
    for (const turn of turns) {
      const value = overlapOf(parent, turn)
      if (value > 0) overlaps.set(turn.speaker, (overlaps.get(turn.speaker) ?? 0) + value)
    }
    split.push({ ...parent, speaker: name(largest(overlaps)) })
  })

  const merged: Segment[] = []
  for (const segment of split) {
    const current = merged[merged.length - 1]
    if (current) {
      const gap = segment.start - current.end
      const pause = endsWithPunctuation(current.text) && gap >= 0.1
      const text = `${current.text.trim()} ${segment.text.trim()}`
      if (
        segment.speaker === current.speaker &&
        gap < 3 &&
        !pause &&
        text.length <= TRANSCRIPTION_SEGMENT_TEXT_MAX
      ) {
        merged[merged.length - 1] = {
          ...current,
          end: segment.end,
          text,
          ...(segment.words ? { words: [...(current.words ?? []), ...segment.words] } : {})
        }
        continue
      }
    }
    merged.push(segment)
  }

  return {
    segments: merged.map((segment, index) => ({
      ...withoutWords(segment),
      id: index + 1,
      speaker: publicName(segment.speaker ?? UNKNOWN)
    })),
    words: words.map((word) => ({ ...word, speaker: publicName(name(word.speaker ?? null)) }))
  }
}
