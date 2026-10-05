import {
  TRANSCRIPTION_SAMPLE_MAX_SECONDS,
  TRANSCRIPTION_SAMPLE_MIN_SECONDS,
  TRANSCRIPTION_SPEAKERS_MAX,
  type TranscriptionSnippet,
  type TranscriptionSpeaker
} from '@justcampus/shared'

/** One stretch of speech of one diarised voice, in seconds of the whole file. */
export interface SpeakerTurn {
  start: number
  end: number
  speaker: string
}

/** Samples the analysis offers per voice: its longest turns, five as in kiChat. */
export const SAMPLES_PER_SPEAKER = 5

/** kiChat's automatic label, which the web app localises (`Stimme 1`, `Voice 1`). */
export function autoSpeakerLabel(index: number): string {
  return `Stimme ${index + 1}`
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** Seconds two ranges share. */
export function overlap(
  a: { start: number; end: number },
  b: { start: number; end: number }
): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start))
}

/**
 * The diarisation's turns made safe and stable: finite, within the media, sorted, and renamed
 * `SPEAKER_00`, `SPEAKER_01`, … by first appearance, whatever the diariser called them. At most
 * `TRANSCRIPTION_SPEAKERS_MAX` voices stay, those who speak longest.
 */
export function normalizeTurns(
  turns: readonly SpeakerTurn[],
  duration: number | null
): SpeakerTurn[] {
  const limit = duration !== null && duration > 0 ? duration : Number.POSITIVE_INFINITY
  const clean = turns
    .filter((turn) => Number.isFinite(turn.start) && Number.isFinite(turn.end))
    .map((turn) => ({
      start: Math.max(0, Math.min(turn.start, limit)),
      end: Math.max(0, Math.min(turn.end, limit)),
      speaker: String(turn.speaker)
    }))
    .filter((turn) => turn.end > turn.start)
    .sort((a, b) => a.start - b.start || a.end - b.end)

  const spoken = new Map<string, number>()
  for (const turn of clean) {
    spoken.set(turn.speaker, (spoken.get(turn.speaker) ?? 0) + turn.end - turn.start)
  }
  const kept = new Set(
    [...spoken.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TRANSCRIPTION_SPEAKERS_MAX)
      .map(([speaker]) => speaker)
  )

  const ids = new Map<string, string>()
  const result: SpeakerTurn[] = []
  for (const turn of clean) {
    if (!kept.has(turn.speaker)) continue
    let id = ids.get(turn.speaker)
    if (id === undefined) {
      id = `SPEAKER_${String(ids.size).padStart(2, '0')}`
      ids.set(turn.speaker, id)
    }
    result.push({ start: turn.start, end: turn.end, speaker: id })
  }
  return result
}

/**
 * A sample window of a turn: from its start, at most five seconds and at least 0.2 seconds, within
 * the media (T-19), rounded to hundredths.
 */
export function sampleWindow(
  turn: { start: number; end: number },
  duration: number | null
): { start: number; end: number } {
  const limit = duration !== null && duration > 0 ? duration : Number.POSITIVE_INFINITY
  let start = turn.start
  let end = Math.min(turn.end, start + TRANSCRIPTION_SAMPLE_MAX_SECONDS, limit)
  if (end - start < TRANSCRIPTION_SAMPLE_MIN_SECONDS) {
    end = Math.min(start + TRANSCRIPTION_SAMPLE_MIN_SECONDS, limit)
    start = Math.max(0, end - TRANSCRIPTION_SAMPLE_MIN_SECONDS)
  }
  return { start: round2(start), end: round2(Math.max(end, start + 0.01)) }
}

/**
 * The voices of normalised turns, by first appearance (T-17): ids, automatic labels, first and last
 * moment, and up to `SAMPLES_PER_SPEAKER` samples from their longest turns, in time order.
 */
export function speakersFromTurns(
  turns: readonly SpeakerTurn[],
  duration: number | null
): TranscriptionSpeaker[] {
  const bySpeaker = new Map<string, SpeakerTurn[]>()
  for (const turn of turns) {
    const list = bySpeaker.get(turn.speaker) ?? []
    list.push(turn)
    bySpeaker.set(turn.speaker, list)
  }
  return [...bySpeaker.entries()]
    .map(([id, own]) => ({ id, own, first: Math.min(...own.map((turn) => turn.start)) }))
    .sort((a, b) => a.first - b.first)
    .map(({ id, own }, index) => {
      const samples = [...own]
        .sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start)
        .slice(0, SAMPLES_PER_SPEAKER)
        .map((turn) => sampleWindow(turn, duration))
        .sort((a, b) => a.start - b.start)
        .map((window, sampleIndex) => ({ id: `${id}-${sampleIndex + 1}`, ...window }))
      return {
        id,
        index,
        label: autoSpeakerLabel(index),
        start: round2(Math.min(...own.map((turn) => turn.start))),
        end: round2(Math.max(...own.map((turn) => turn.end))),
        samples
      }
    })
}

/** The id of the one automatic voice a file gets without diarisation. */
export const AUTOMATIC_VOICE_ID = 'SPEAKER_00'

/**
 * The one voice of a file whose voices could not be analysed (no diarisation set up, or the
 * diariser unavailable): the whole file, automatically labelled, without samples, since nothing
 * was heard apart.
 */
export function automaticVoice(duration: number | null): TranscriptionSpeaker {
  return {
    id: AUTOMATIC_VOICE_ID,
    index: 0,
    label: autoSpeakerLabel(0),
    start: 0,
    end: round2(duration !== null && duration > 0 ? duration : 0),
    samples: []
  }
}

/**
 * The name of the automatic voice in the transcript: what the user named it at dispatch (by
 * mapping, else by snippet), else its automatic label.
 */
export function automaticVoiceName(
  mapping: Readonly<Record<string, string>>,
  snippets: readonly TranscriptionSnippet[]
): string {
  return (
    mapping[AUTOMATIC_VOICE_ID]?.trim() ||
    snippets.find((snippet) => snippet.id === AUTOMATIC_VOICE_ID)?.name.trim() ||
    autoSpeakerLabel(0)
  )
}
