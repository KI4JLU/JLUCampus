import {
  defaultSpeakerColorId,
  TRANSCRIPTION_REDACTED_TEXT,
  type TranscriptFormatFlags,
  type TranscriptionSegment,
  type TranscriptionSpeakerColorId,
  type TranscriptionSpeakerColorMap
} from '@justcampus/shared'
import { redactedText as replaceRanges, speakerLabel as storedSpeakerLabel } from '../segments'

/**
 * The transcript as the export shows and writes it, after kiChat's `exportToVerlauf` (T-43):
 * speaker blocks, names, timestamps, anonymised names, chronological or by speaker, without the
 * speakers the user hid. Pure functions over the segments; the segments themselves never change.
 */

/** What the formatted transcript calls speakers it has no name for. */
export interface SpeakerLabels {
  /** A segment without a speaker (`Unbekannt`). */
  unknown: string
  /** A stretch the result workspace stored as `Unbekannt 2`, in the current language. */
  unknownN: (n: number) => string
  /** An automatic voice label (`Stimme 2`, `Speaker 2`) in the current language. */
  voice: (n: number) => string
  /** An anonymised speaker, numbered by first appearance (`Speaker 1`). */
  anonymous: (n: number) => string
}

/** Seconds as `HH:MM:SS`, as kiChat's `formatSecondsToTime`. */
export function formatClock(seconds: number): string {
  const total = Math.max(0, seconds)
  const hours = String(Math.floor(total / 3600)).padStart(2, '0')
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, '0')
  const secs = String(Math.floor(total % 60)).padStart(2, '0')
  return `${hours}:${minutes}:${secs}`
}

/**
 * A segment's text with each redacted range replaced by `[AUSGEBLENDET]` (T-33), trimmed. kiChat
 * trimmed before applying the offsets, which shifts them when the text starts with blanks; the
 * offsets belong to the stored text, so they are applied first here (with the result workspace's
 * `redactedText`, which merges overlapping ranges).
 */
export function redactedText(
  segment: Pick<TranscriptionSegment, 'text' | 'redactions'>,
  replacement: string = TRANSCRIPTION_REDACTED_TEXT
): string {
  return replaceRanges(segment.text ?? '', segment.redactions ?? [], replacement).trim()
}

/** The key a segment's speaker is grouped, hidden and coloured by. */
export function speakerKey(
  segment: Pick<TranscriptionSegment, 'speaker'>,
  unknown: string
): string {
  return segment.speaker ?? unknown
}

/**
 * A speaker as people read it: names the user typed stay as they are, automatic labels
 * (`Stimme 2`, `Unbekannt 2`) show in the current language, a missing speaker is "unknown".
 */
export function speakerLabel(name: string | null, labels: SpeakerLabels): string {
  if (name === null) return labels.unknown
  return storedSpeakerLabel(name, { unknown: labels.unknownN, voice: labels.voice })
}

/** The speakers in order of first appearance, missing ones as `unknown`. */
export function speakersInOrder(
  segments: readonly Pick<TranscriptionSegment, 'speaker'>[],
  unknown: string
): string[] {
  const seen = new Set<string>()
  for (const segment of segments) seen.add(speakerKey(segment, unknown))
  return [...seen]
}

/**
 * Generic names numbered in order of first appearance (T-43), the same for one speaker wherever
 * it appears. Missing speakers count as one speaker, as in kiChat.
 */
export function anonymousNames(
  segments: readonly Pick<TranscriptionSegment, 'speaker'>[],
  labels: Pick<SpeakerLabels, 'unknown' | 'anonymous'>
): Map<string, string> {
  const names = new Map<string, string>()
  for (const key of speakersInOrder(segments, labels.unknown)) {
    names.set(key, labels.anonymous(names.size + 1))
  }
  return names
}

/**
 * A speaker's avatar colour: the one chosen for the transcript, else the default of their place
 * in the order of appearance of the whole transcript.
 */
export function speakerColorId(
  key: string,
  colors: TranscriptionSpeakerColorMap,
  order: readonly string[]
): TranscriptionSpeakerColorId {
  const chosen = colors[key]
  if (chosen) return chosen.colorId
  const index = order.indexOf(key)
  return defaultSpeakerColorId(index === -1 ? order.length : index)
}

/** Which speakers show; a speaker missing from the map shows. */
export type VisibleSpeakers = Readonly<Record<string, boolean>>

export function isSpeakerVisible(visible: VisibleSpeakers, key: string): boolean {
  return visible[key] !== false
}

/** One block of the formatted transcript. */
export interface TranscriptBlock {
  /** The speaker's key (`speakerKey`), for hiding and colours. */
  speaker: string
  /** The name shown: anonymised, localised or as typed. */
  name: string
  colorId: TranscriptionSpeakerColorId
  /** Start of the block's first segment, in seconds. */
  start: number
  /**
   * The text: one line in chronological order; one line per segment when grouped by speaker,
   * each with its timestamp when timestamps are on.
   */
  lines: string[]
}

export interface FormattedTranscript {
  blocks: TranscriptBlock[]
  /**
   * The running record's participant list in order of appearance: the shown speakers' names and
   * an `Unbekannt {n}` per segment without a speaker, as kiChat lists them.
   */
  participants: string[]
  /** Every speaker is hidden (and there were segments). */
  allHidden: boolean
}

/** A pause after which kiChat starts a new block even for the same speaker, in seconds. */
export const BLOCK_GAP_SECONDS = 10

/**
 * The transcript's blocks for the chosen format (T-43). Chronological: consecutive segments of
 * one speaker form a block until a pause of more than ten seconds. By speaker: one block per
 * speaker in order of appearance. Hidden speakers are left out; anonymising numbers the shown
 * speakers in order of appearance.
 */
export function formatTranscript(
  segments: readonly TranscriptionSegment[],
  flags: Pick<TranscriptFormatFlags, 'timestamps' | 'anonymize' | 'order'>,
  visible: VisibleSpeakers,
  colors: TranscriptionSpeakerColorMap,
  labels: SpeakerLabels
): FormattedTranscript {
  const order = speakersInOrder(segments, labels.unknown)
  const shown = segments.filter((segment) =>
    isSpeakerVisible(visible, speakerKey(segment, labels.unknown))
  )
  const anonymous = flags.anonymize ? anonymousNames(shown, labels) : null
  const nameOf = (key: string, segment: TranscriptionSegment): string =>
    anonymous?.get(key) ?? speakerLabel(segment.speaker, labels)
  const participants = participantNames(shown, anonymous, labels)

  const blocks: TranscriptBlock[] = []
  if (flags.order === 'speaker') {
    const bySpeaker = new Map<string, TranscriptBlock>()
    for (const segment of shown) {
      const key = speakerKey(segment, labels.unknown)
      let block = bySpeaker.get(key)
      if (!block) {
        block = {
          speaker: key,
          name: nameOf(key, segment),
          colorId: speakerColorId(key, colors, order),
          start: segment.start,
          lines: []
        }
        bySpeaker.set(key, block)
        blocks.push(block)
      }
      const text = redactedText(segment)
      block.lines.push(flags.timestamps ? `[${formatClock(segment.start)}] ${text}` : text)
    }
  } else {
    let current: { block: TranscriptBlock; parts: string[] } | null = null
    shown.forEach((segment, index) => {
      const key = speakerKey(segment, labels.unknown)
      const previous = shown[index - 1]
      const gap = previous ? segment.start - previous.end : 0
      if (!current || current.block.speaker !== key || gap > BLOCK_GAP_SECONDS) {
        if (current) current.block.lines = [current.parts.join(' ').trim()]
        current = {
          block: {
            speaker: key,
            name: nameOf(key, segment),
            colorId: speakerColorId(key, colors, order),
            start: segment.start,
            lines: []
          },
          parts: []
        }
        blocks.push(current.block)
      }
      current.parts.push(redactedText(segment))
    })
    if (current) {
      const last = current as { block: TranscriptBlock; parts: string[] }
      last.block.lines = [last.parts.join(' ').trim()]
    }
  }

  return { blocks, participants, allHidden: segments.length > 0 && shown.length === 0 }
}

/**
 * The running record's participants as kiChat's `exportToVerlauf` lists them: each segment without
 * a speaker adds its own `Unbekannt {n}`, counted per such segment and never anonymised; named
 * speakers appear once each, anonymised when that is on.
 */
function participantNames(
  shown: readonly TranscriptionSegment[],
  anonymous: Map<string, string> | null,
  labels: SpeakerLabels
): string[] {
  const names = new Set<string>()
  let unknownCount = 1
  for (const segment of shown) {
    if (segment.speaker === null) names.add(labels.unknownN(unknownCount++))
    else names.add(anonymous?.get(segment.speaker) ?? speakerLabel(segment.speaker, labels))
  }
  return [...names]
}

/** The texts of the running record's head, in the current language. */
export interface ProtocolLabels {
  /** `VERLAUFSPROTOKOLL` */
  header: string
  /** `Erstellt am: …` with the time already filled in. */
  createdAt: string
  /** `Transkription-ID: …`, or `null` without a saved transcript. */
  transcriptId: string | null
  /** `TEILNEHMER:` */
  participants: string
  /** What the record says when every speaker is hidden. */
  allHidden: string
}

/**
 * The running record (`VERLAUFSPROTOKOLL`) kiChat downloads as Markdown and turns into Word and PDF
 * files for the full transcript: a head with time, transcript id and participants, a rule, then the
 * blocks with their headers as the format asks.
 */
export function protocolText(
  formatted: FormattedTranscript,
  flags: Pick<TranscriptFormatFlags, 'speakers' | 'timestamps' | 'order'>,
  labels: ProtocolLabels
): string {
  if (formatted.allHidden) return labels.allHidden
  let text = `${labels.header}\n${labels.createdAt}\n`
  if (labels.transcriptId) text += `${labels.transcriptId}\n`
  text += `\n${labels.participants}\n`
  for (const name of formatted.participants) text += `- ${name}\n`
  text += `\n${'='.repeat(50)}\n\n`

  if (flags.order === 'speaker') {
    for (const block of formatted.blocks) {
      text += `${block.name}:\n${block.lines.join('\n').trim()}\n\n`
    }
    return text
  }
  formatted.blocks.forEach((block, index) => {
    const time = `[${formatClock(block.start)}]`
    const header =
      flags.timestamps && flags.speakers
        ? `${time} ${block.name}:\n`
        : flags.timestamps
          ? `${time}:\n`
          : flags.speakers
            ? `${block.name}:\n`
            : ''
    const last = index === formatted.blocks.length - 1
    text += `${header}${block.lines.join('\n').trim()}${last ? '\n' : '\n\n'}`
  })
  return text
}

/**
 * The formatted transcript as the preview reads as plain text, which kiChat copies and saves as
 * `.txt` (the `innerText` of its block `<div>`s): per block the name and the time on lines of
 * their own when shown, then the text; blocks follow each other without a blank line.
 */
export function transcriptPlainText(
  formatted: FormattedTranscript,
  flags: Pick<TranscriptFormatFlags, 'speakers' | 'timestamps' | 'order'>,
  allHidden: string
): string {
  if (formatted.allHidden) return allHidden
  return formatted.blocks
    .map((block) => {
      const lines: string[] = []
      if (flags.speakers) lines.push(block.name)
      if (flags.timestamps && flags.order !== 'speaker') lines.push(`[${formatClock(block.start)}]`)
      return [...lines, ...block.lines.map((line) => line.trim())].join('\n')
    })
    .join('\n')
}

/** The decoder fields under the names Whisper's `verbose_json` and kiChat's export give them. */
const WHISPER_FIELD_NAMES: Partial<Record<keyof TranscriptionSegment, string>> = {
  avgLogprob: 'avg_logprob',
  compressionRatio: 'compression_ratio',
  noSpeechProb: 'no_speech_prob'
}

/**
 * The raw segments as two-space JSON (T-47): no format, filter or anonymisation applies. The
 * decoder fields keep Whisper's names, so tools written for kiChat's export read it unchanged.
 */
export function segmentsJson(segments: readonly TranscriptionSegment[]): string {
  return JSON.stringify(
    segments.map((segment) =>
      Object.fromEntries(
        Object.entries(segment).map(([key, value]) => [
          WHISPER_FIELD_NAMES[key as keyof TranscriptionSegment] ?? key,
          value
        ])
      )
    ),
    null,
    2
  )
}

/** Up to two initials of a name. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const letters =
    words.length > 1 ? [words[0]![0], words[1]![0]] : [...(words[0] ?? '?')].slice(0, 2)
  return letters.join('').toUpperCase()
}
