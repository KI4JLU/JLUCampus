import {
  TRANSCRIPTION_SAMPLE_MAX_SECONDS,
  TRANSCRIPTION_SAMPLE_MIN_SECONDS,
  TRANSCRIPTION_SPEAKERS_MAX,
  type TranscriptionSegment,
  type TranscriptionSnippet,
  type TranscriptionSpeaker,
  type TranscriptionWord
} from '@justcampus/shared'

/** One stretch of speech of one diarised voice, in seconds of the whole file. */
export interface SpeakerTurn {
  start: number
  end: number
  speaker: string
}

/** Samples the analysis offers per voice: its longest turns. */
export const SAMPLES_PER_SPEAKER = 3

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

/** A voice the user named at dispatch: its name, the ids it was sent with and all its windows. */
interface NamedVoice {
  name: string
  ids: Set<string>
  windows: TranscriptionSnippet[]
}

/** The voices the user named at dispatch, in first-seen order. */
function namedVoices(snippets: readonly TranscriptionSnippet[]): NamedVoice[] {
  const voices = new Map<string, NamedVoice>()
  for (const snippet of snippets) {
    const name = snippet.name.trim()
    if (!name) continue
    const voice = voices.get(name) ?? { name, ids: new Set<string>(), windows: [] }
    voice.ids.add(snippet.id)
    voice.windows.push(snippet)
    voices.set(name, voice)
  }
  return [...voices.values()]
}

/**
 * The name of each diarised voice (owner decision): the named voice whose sample windows overlap
 * its turns most. So a voice the user added by hand names whatever the diariser heard in its
 * windows, without an identification service. A voice no window touches keeps the name the
 * mapping gives its id, else its automatic label.
 */
export function resolveSpeakerNames(
  turns: readonly SpeakerTurn[],
  speakers: readonly Pick<TranscriptionSpeaker, 'id' | 'index'>[],
  mapping: Readonly<Record<string, string>>,
  snippets: readonly TranscriptionSnippet[]
): Map<string, string> {
  const voices = namedVoices(snippets)
  const ids = new Set([...speakers.map((speaker) => speaker.id), ...turns.map((t) => t.speaker)])
  const indexOf = new Map(speakers.map((speaker) => [speaker.id, speaker.index]))
  const names = new Map<string, string>()
  let nextIndex = speakers.length
  for (const id of ids) {
    const own = turns.filter((turn) => turn.speaker === id)
    let best: { name: string; seconds: number; own: boolean } | null = null
    for (const voice of voices) {
      let seconds = 0
      for (const window of voice.windows) {
        for (const turn of own) seconds += overlap(window, turn)
      }
      if (seconds <= 0) continue
      const ownVoice = voice.ids.has(id)
      // Ties go to the voice the user named for this very id, then to the first named.
      if (
        !best ||
        seconds > best.seconds + 1e-9 ||
        (Math.abs(seconds - best.seconds) <= 1e-9 && ownVoice && !best.own)
      ) {
        best = { name: voice.name, seconds, own: ownVoice }
      }
    }
    const mapped = mapping[id]?.trim()
    const index = indexOf.get(id) ?? nextIndex++
    names.set(id, best?.name ?? (mapped || autoSpeakerLabel(index)))
  }
  return names
}

/** The diarised voice speaking most within a range, else the nearest one; `null` without turns. */
function speakerAt(
  turns: readonly SpeakerTurn[],
  range: { start: number; end: number }
): string | null {
  if (turns.length === 0) return null
  const spoken = new Map<string, number>()
  for (const turn of turns) {
    if (turn.end <= range.start || turn.start >= range.end) continue
    spoken.set(turn.speaker, (spoken.get(turn.speaker) ?? 0) + overlap(turn, range))
  }
  let best: string | null = null
  let seconds = 0
  for (const [speaker, value] of spoken) {
    if (value > seconds) {
      best = speaker
      seconds = value
    }
  }
  if (best) return best
  // A segment between turns (or a zero-length word) belongs to the closest voice.
  const middle = (range.start + range.end) / 2
  let nearest = turns[0]!
  let distance = Number.POSITIVE_INFINITY
  for (const turn of turns) {
    const gap =
      middle < turn.start ? turn.start - middle : middle > turn.end ? middle - turn.end : 0
    if (gap < distance) {
      nearest = turn
      distance = gap
    }
  }
  return nearest.speaker
}

/** Without diarisation: the named voice whose windows overlap a range most, if any. */
function windowNameAt(
  voices: readonly NamedVoice[],
  range: { start: number; end: number }
): string | null {
  let best: string | null = null
  let seconds = 0
  for (const voice of voices) {
    const value = voice.windows.reduce((sum, window) => sum + overlap(window, range), 0)
    if (value > seconds) {
      best = voice.name
      seconds = value
    }
  }
  return best
}

/**
 * Gives each segment and word the name of the diarised voice speaking most during it (T-17). With
 * no turns at all (no diarisation), the named windows themselves decide, else the speaker stays
 * `null`. Text and timing are untouched.
 */
export function assignSpeakers(
  segments: readonly TranscriptionSegment[],
  words: readonly TranscriptionWord[],
  turns: readonly SpeakerTurn[],
  names: ReadonlyMap<string, string>,
  snippets: readonly TranscriptionSnippet[]
): { segments: TranscriptionSegment[]; words: TranscriptionWord[] } {
  const voices = namedVoices(snippets)
  const nameAt = (range: { start: number; end: number }): string | null => {
    if (turns.length === 0) return windowNameAt(voices, range)
    const speaker = speakerAt(turns, range)
    return speaker === null ? null : (names.get(speaker) ?? null)
  }
  return {
    segments: segments.map((segment) => ({ ...segment, speaker: nameAt(segment) })),
    words: words.map((word) => ({ ...word, speaker: nameAt(word) }))
  }
}
