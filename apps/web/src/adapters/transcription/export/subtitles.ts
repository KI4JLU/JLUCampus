import type { TranscriptionSegment } from '@justcampus/shared'
import {
  anonymousNames,
  redactedText,
  speakerKey,
  speakerLabel,
  type SpeakerLabels
} from './format'

/**
 * Subtitles after kiChat's `Utils.getSubtitleBlocks` (T-46): each segment's text, redacted and
 * with `[Name]:` before it for known speakers, wrapped at 42 characters into cues of two lines.
 * A cue's time is its share of the segment by length; cues keep half a second apart, last at most
 * seven seconds and at least one second or a seventeenth of a second per character. Long words
 * and minimum durations may run past a segment; cues do not follow single words.
 */

/** Characters per subtitle line and lines per cue. */
export const SUBTITLE_LINE_CHARS = 42
export const SUBTITLE_CUE_LINES = 2
/** Seconds between two cues, the longest a cue lasts if it can, and the reading speed. */
export const SUBTITLE_GAP_SECONDS = 0.5
export const SUBTITLE_TARGET_SECONDS = 7
export const SUBTITLE_MIN_SECONDS = 1
export const SUBTITLE_CHARS_PER_SECOND = 17

export interface SubtitleCue {
  start: number
  end: number
  /** One or two lines, joined by `\n`. */
  text: string
}

/** Words greedily filled into lines of at most `SUBTITLE_LINE_CHARS`; a longer word stands alone. */
export function wrapSubtitleLines(text: string): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/)) {
    if (!word) continue
    if (line.length === 0) line = word
    else if (line.length + 1 + word.length <= SUBTITLE_LINE_CHARS) line += ` ${word}`
    else {
      lines.push(line)
      line = word
    }
  }
  if (line) lines.push(line)
  return lines
}

/**
 * Whether a speaker is named in the subtitles: not a missing one, and not kiChat's German
 * `Unbekannt …` labels (or the current language's word for unknown).
 */
function namedSpeaker(name: string | null, unknown: string): boolean {
  return name !== null && !name.startsWith('Unbekannt') && name !== unknown
}

/**
 * The cues of a transcript. With `anonymize` (the transcript format's flag, as in kiChat) the
 * names are numbered by first appearance.
 */
export function subtitleCues(
  segments: readonly TranscriptionSegment[],
  labels: SpeakerLabels,
  anonymize = false
): SubtitleCue[] {
  const anonymous = anonymize ? anonymousNames(segments, labels) : null
  const raw: { text: string; desiredStart: number; desiredEnd: number; minDuration: number }[] = []

  for (const segment of segments) {
    const name = namedSpeaker(segment.speaker, labels.unknown)
      ? (anonymous?.get(speakerKey(segment, labels.unknown)) ??
        speakerLabel(segment.speaker, labels))
      : null
    const text = redactedText(segment)
    const line = name ? `[${name}]: ${text}` : text
    if (!line) continue

    const lines = wrapSubtitleLines(line)
    const cues: string[] = []
    for (let index = 0; index < lines.length; index += SUBTITLE_CUE_LINES) {
      cues.push(lines.slice(index, index + SUBTITLE_CUE_LINES).join('\n'))
    }
    if (cues.length === 0) continue

    // kiChat measures a cue without its first line break.
    const lengthOf = (cue: string): number => cue.replace('\n', '').length
    const total = cues.reduce((sum, cue) => sum + lengthOf(cue), 0)
    const duration = segment.end - segment.start
    let done = 0
    for (const cue of cues) {
      const length = lengthOf(cue)
      raw.push({
        text: cue,
        desiredStart: segment.start + (total > 0 ? duration * (done / total) : 0),
        desiredEnd: segment.start + (total > 0 ? duration * ((done + length) / total) : duration),
        minDuration: Math.max(SUBTITLE_MIN_SECONDS, length / SUBTITLE_CHARS_PER_SECOND)
      })
      done += length
    }
  }

  const result: SubtitleCue[] = []
  let lastEnd = -SUBTITLE_GAP_SECONDS
  for (const cue of raw) {
    const start = Math.max(lastEnd + SUBTITLE_GAP_SECONDS, cue.desiredStart)
    const duration = Math.max(
      cue.minDuration,
      Math.min(SUBTITLE_TARGET_SECONDS, cue.desiredEnd - start)
    )
    const end = start + duration
    result.push({ start, end, text: cue.text })
    lastEnd = end
  }
  return result
}

/**
 * `HH:MM:SS,mmm`, as kiChat's `formatSecondsToSRT`: whole seconds and milliseconds cut, not
 * rounded. Hours go past 24 instead of wrapping.
 */
export function formatSubtitleTime(seconds: number, separator: ',' | '.' = ','): string {
  const total = Math.max(0, seconds)
  const whole = Math.floor(total)
  const hours = String(Math.floor(whole / 3600)).padStart(2, '0')
  const minutes = String(Math.floor((whole % 3600) / 60)).padStart(2, '0')
  const secs = String(whole % 60).padStart(2, '0')
  const millis = String(Math.floor((total % 1) * 1000)).padStart(3, '0')
  return `${hours}:${minutes}:${secs}${separator}${millis}`
}

function cueText(cues: readonly SubtitleCue[], separator: ',' | '.'): string {
  return cues
    .map(
      (cue, index) =>
        `${index + 1}\n${formatSubtitleTime(cue.start, separator)} --> ${formatSubtitleTime(cue.end, separator)}\n${cue.text}\n\n`
    )
    .join('')
}

/** SubRip: numbered cues with comma milliseconds. */
export function toSrt(cues: readonly SubtitleCue[]): string {
  return cueText(cues, ',')
}

/** WebVTT: the `WEBVTT` head, then the cues with dot milliseconds. */
export function toVtt(cues: readonly SubtitleCue[]): string {
  return `WEBVTT\n\n${cueText(cues, '.')}`
}
