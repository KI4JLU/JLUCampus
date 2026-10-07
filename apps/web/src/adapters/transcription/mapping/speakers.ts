import {
  defaultSpeakerColorId,
  TRANSCRIPTION_AUTO_SPEAKER_LABEL,
  TRANSCRIPTION_SAMPLE_MAX_SECONDS,
  TRANSCRIPTION_SAMPLE_MIN_SECONDS,
  TRANSCRIPTION_SAMPLES_PER_SPEAKER_MAX,
  TRANSCRIPTION_SPEAKER_NAME_MAX,
  type TranscriptionSnippet,
  type TranscriptionSpeaker,
  type TranscriptionSpeakerColorId
} from '@justcampus/shared'

/**
 * The voices of an analysed file as the mapping dialog edits them (T-17 to T-20), after kiChat's
 * `file.speakers`, `file.speakerMapping` and the avatar colours. Everything here is plain data and
 * pure functions; the dialog and the upload queue keep the state.
 */

/** One time window of a voice: a sample the analysis found, or one the user added (T-19). */
export interface SampleDraft {
  /** Unique within its voice, local only. */
  key: string
  /** `Beispiel 1`, editable; it is not sent anywhere. */
  label: string
  start: number
  end: number
}

/** A voice with the name, colour and samples the user gave it. */
export interface VoiceDraft {
  /** The diarisation's id (`SPEAKER_00`), or `manual_…` for a voice the user added (T-20). */
  id: string
  manual: boolean
  /** The name typed; an automatic label (`Stimme 1`) counts as no name (T-17). */
  name: string
  /** `null`: the colour of its place in the list. */
  colorId: TranscriptionSpeakerColorId | null
  /** First and last moment the analysis heard the voice; `null` for added voices. Order only. */
  start: number | null
  end: number | null
  /**
   * The window dispatch sends when every sample was deleted: the analysis' first sample, as kiChat
   * sends the manifest's `start`/`end`; the whole file for the automatic voice, which has no
   * samples; `null` for added voices.
   */
  fallback: TimeWindow | null
  samples: SampleDraft[]
}

/** A sample's time window in seconds. */
export interface TimeWindow {
  start: number
  end: number
}

/** Translates the automatic labels: `Voice 3` for `n = 3`, `Beispiel 1` for samples. */
export type NumberedLabel = (n: number) => string

/** Whether a name is an automatic label (`Stimme 2`, `Speaker 2`, …) rather than one typed. */
export function isAutoLabel(name: string): boolean {
  return TRANSCRIPTION_AUTO_SPEAKER_LABEL.test(name.trim())
}

/**
 * kiChat's `localizeAutoSpeakerLabel`: an automatic label in the UI language, keeping its number
 * (else the voice's place, from 0); names users typed stay as they are; empty stays empty.
 */
export function localizeAutoLabel(name: string, index: number, autoLabel: NumberedLabel): string {
  const trimmed = name.trim()
  if (trimmed === '') return ''
  const match = TRANSCRIPTION_AUTO_SPEAKER_LABEL.exec(trimmed)
  if (!match) return trimmed
  return autoLabel(match[1] ? Number(match[1]) : index + 1)
}

/** An automatic sample label (`Beispiel 2`, `Sample 2`). */
const AUTO_SAMPLE_LABEL = /^(?:Beispiel|Sample)\s+(\d+)$/i

/** A sample's automatic label in the UI language, keeping its number; typed labels stay. */
export function localizeSampleLabel(label: string, sampleLabel: NumberedLabel): string {
  const match = AUTO_SAMPLE_LABEL.exec(label.trim())
  return match ? sampleLabel(Number(match[1])) : label
}

/** kiChat's `getUnidentifiedSpeakersCount`: voices without a name, or with an automatic one. */
export function unidentifiedVoiceCount(voices: readonly VoiceDraft[] | null): number {
  if (!voices) return 0
  return voices.filter((voice) => voice.name.trim() === '' || isAutoLabel(voice.name)).length
}

/** The colour a voice shows: the one chosen, else that of its place. */
export function voiceColor(voice: VoiceDraft, index: number): TranscriptionSpeakerColorId {
  return voice.colorId ?? defaultSpeakerColorId(index)
}

/** Analysed voices by their first moment (T-18); voices added by hand keep their order last. */
export function orderVoices(voices: readonly VoiceDraft[]): VoiceDraft[] {
  const analysed = voices.filter((voice) => voice.start !== null)
  const manual = voices.filter((voice) => voice.start === null)
  return [...analysed.sort((a, b) => (a.start ?? 0) - (b.start ?? 0)), ...manual]
}

/**
 * The analysis's voices as drafts, named with their localised automatic label as kiChat names
 * them. With `previous`, voices that are still there keep the name, colour and samples given, and
 * the voices added by hand stay after them: only the user removes those (T-20).
 */
export function voicesFromSpeakers(
  speakers: readonly TranscriptionSpeaker[],
  labels: { autoLabel: NumberedLabel; sampleLabel: NumberedLabel },
  previous: readonly VoiceDraft[] | null = null
): VoiceDraft[] {
  const sorted = [...speakers].sort((a, b) => a.start - b.start || a.index - b.index)
  const found = new Set(sorted.map((speaker) => speaker.id))
  const manual = (previous ?? []).filter((voice) => voice.manual && !found.has(voice.id))
  const analysed = sorted.map((speaker, index): VoiceDraft => {
    const kept = previous?.find((voice) => voice.id === speaker.id)
    const fallback = fallbackWindow(speaker)
    if (kept) return { ...kept, start: speaker.start, end: speaker.end, fallback }
    return {
      id: speaker.id,
      manual: false,
      name:
        localizeAutoLabel(speaker.label ?? '', index, labels.autoLabel) ||
        labels.autoLabel(index + 1),
      colorId: null,
      start: speaker.start,
      end: speaker.end,
      fallback,
      samples: speaker.samples.map((sample, sampleIndex) => ({
        key: `${speaker.id}:${sample.id}`,
        label: labels.sampleLabel(sampleIndex + 1),
        start: sample.start,
        end: sample.end
      }))
    }
  })
  return [...analysed, ...manual]
}

/** The analysis' first sample of a voice, else the whole range it was heard in. */
function fallbackWindow(speaker: TranscriptionSpeaker): TimeWindow {
  const first = speaker.samples[0]
  return first ? { start: first.start, end: first.end } : { start: speaker.start, end: speaker.end }
}

/** A new voice added by hand, without samples yet (T-20); the id is unique in the file. */
export function manualVoice(
  voices: readonly VoiceDraft[],
  autoLabel: NumberedLabel,
  now: number = Date.now()
): VoiceDraft {
  let id = `manual_${now}`
  for (let suffix = 1; voices.some((voice) => voice.id === id); suffix++) {
    id = `manual_${now}_${suffix}`
  }
  return {
    id,
    manual: true,
    name: autoLabel(voices.length + 1),
    colorId: null,
    start: null,
    end: null,
    fallback: null,
    samples: []
  }
}

// ---------------------------------------------------------------------------
// Sample windows (T-19)
// ---------------------------------------------------------------------------

const round2 = (value: number): number => Math.round(value * 100) / 100

/** The end a window may reach: the audio's length, or no limit while it is unknown. */
function limitOf(duration: number | null): number {
  return duration !== null && Number.isFinite(duration) && duration > 0 ? duration : Infinity
}

/** Rounds both ends to two decimals, as kiChat's editor stores them. */
export function roundWindow(window: TimeWindow): TimeWindow {
  return { start: round2(window.start), end: round2(window.end) }
}

/**
 * kiChat's `moveEdge`: moves one end of the window, keeping it between 0.2 and 5 seconds long and
 * inside the audio. Pulling an end beyond the longest window drags the other end along, so the
 * whole window slides.
 */
export function moveWindowEdge(
  window: TimeWindow,
  edge: 'start' | 'end',
  target: number,
  duration: number | null,
  maxLength: number = TRANSCRIPTION_SAMPLE_MAX_SECONDS
): TimeWindow {
  const limit = limitOf(duration)
  let { start, end } = window
  if (edge === 'start') {
    start = Math.max(0, Math.min(target, end - TRANSCRIPTION_SAMPLE_MIN_SECONDS))
    if (end - start > maxLength) end = Math.min(limit, start + maxLength)
  } else {
    end = Math.min(limit, Math.max(target, start + TRANSCRIPTION_SAMPLE_MIN_SECONDS))
    if (end - start > maxLength) start = Math.max(0, end - maxLength)
  }
  return roundWindow({ start, end })
}

/** kiChat's `slideWindowTo`: moves the window to start at `start`, its length kept, in bounds. */
export function slideWindow(
  window: TimeWindow,
  start: number,
  duration: number | null
): TimeWindow {
  const length = window.end - window.start
  const limit = limitOf(duration)
  const latest = Number.isFinite(limit) ? Math.max(0, limit - length) : Infinity
  const clamped = Math.max(0, Math.min(latest, start))
  return roundWindow({ start: clamped, end: clamped + length })
}

/**
 * Makes any window valid: inside the audio, at least 0.2 and at most 5 seconds long. `null` when
 * the audio is shorter than the shortest window.
 */
export function clampWindow(window: TimeWindow, duration: number | null): TimeWindow | null {
  const limit = limitOf(duration)
  if (limit < TRANSCRIPTION_SAMPLE_MIN_SECONDS) return null
  const wanted = Math.min(
    TRANSCRIPTION_SAMPLE_MAX_SECONDS,
    Math.max(TRANSCRIPTION_SAMPLE_MIN_SECONDS, window.end - window.start)
  )
  const length = Math.min(wanted, limit)
  const start = Math.max(0, Math.min(window.start, limit - length))
  return roundWindow({ start, end: start + length })
}

/**
 * Where kiChat puts a new sample: two seconds after the last one, five seconds long, inside the
 * audio. At the end of the audio it takes its last five seconds instead of an empty window.
 */
export function newSampleWindow(
  samples: readonly TimeWindow[],
  duration: number | null
): TimeWindow | null {
  const lastEnd = samples.length > 0 ? (samples[samples.length - 1]?.end ?? 0) : 0
  const start = lastEnd + 2
  return clampWindow({ start, end: start + TRANSCRIPTION_SAMPLE_MAX_SECONDS }, duration)
}

/**
 * The stretch of audio the window editor shows: ten times the window and at least ten seconds,
 * centred on it, inside the audio. kiChat zoomed so the window always took a tenth of the track;
 * on long files a whole-file scale would make a five-second window too narrow to grab.
 */
export function windowView(window: TimeWindow, duration: number | null): TimeWindow {
  const limit = limitOf(duration)
  const total = Number.isFinite(limit) ? limit : Math.max(window.end + 10, 10)
  const span = Math.min(total, Math.max(10, (window.end - window.start) * 10))
  const center = (window.start + window.end) / 2
  const start = Math.max(0, Math.min(center - span / 2, total - span))
  return { start, end: start + span }
}

/** The number of the next `Beispiel n`: one above the highest number at a label's end. */
export function nextSampleNumber(samples: readonly SampleDraft[]): number {
  let highest = 0
  for (const sample of samples) {
    const match = /(\d+)\s*$/.exec(sample.label)
    if (match) highest = Math.max(highest, Number(match[1]))
  }
  return highest + 1
}

/** Whether a voice can take another sample. */
export function canAddSample(voice: VoiceDraft): boolean {
  return voice.samples.length < TRANSCRIPTION_SAMPLES_PER_SPEAKER_MAX
}

/**
 * A time typed into the editor: seconds (`12.5`, `12,5`), `mm:ss` or `hh:mm:ss`, decimals allowed
 * in the seconds. `null` for anything else.
 */
export function parseTime(text: string): number | null {
  const parts = text.trim().replace(/,/g, '.').split(':')
  if (parts.length === 0 || parts.length > 3) return null
  if (!parts.every((part) => /^\d+(\.\d+)?$/.test(part))) return null
  const numbers = parts.map(Number)
  const seconds = numbers.reduce((total, value) => total * 60 + value, 0)
  return Number.isFinite(seconds) ? seconds : null
}

/** `mm:ss.ss` (`hh:mm:ss.ss` from an hour), the precision windows are stored with. */
export function formatWindowTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00.00'
  const hundredths = Math.round(seconds * 100)
  const hours = Math.floor(hundredths / 360_000)
  const minutes = Math.floor((hundredths % 360_000) / 6000)
  const rest = (hundredths % 6000) / 100
  const mmss = `${String(minutes).padStart(2, '0')}:${rest.toFixed(2).padStart(5, '0')}`
  return hours > 0 ? `${String(hours).padStart(2, '0')}:${mmss}` : mmss
}

// ---------------------------------------------------------------------------
// Dispatch (T-18 to T-20)
// ---------------------------------------------------------------------------

/** What dispatch sends of the voices: names by voice id, named windows and colours. */
export interface VoiceDispatch {
  mapping: Record<string, string>
  snippets: TranscriptionSnippet[]
  colors: Record<string, TranscriptionSpeakerColorId>
}

/**
 * The names and windows sent with dispatch. A voice without a name goes by its automatic label, as
 * kiChat sends `mapping || label || id`. Every sample is a window the server matches the
 * diarised speakers against; an analysed voice whose samples were all deleted sends its first
 * analysed sample, as kiChat sends the manifest's `speaker.start`/`end` (that sample, at most five
 * seconds), never the whole stretch it was heard in, which would cover the other voices' turns
 * too. Invalid windows are left out.
 */
export function voiceDispatch(
  voices: readonly VoiceDraft[],
  duration: number | null,
  autoLabel: NumberedLabel
): VoiceDispatch {
  const result: VoiceDispatch = { mapping: {}, snippets: [], colors: {} }
  voices.forEach((voice, index) => {
    const typed = localizeAutoLabel(voice.name, index, autoLabel)
    const name = (typed || autoLabel(index + 1)).slice(0, TRANSCRIPTION_SPEAKER_NAME_MAX)
    result.mapping[voice.id] = name
    result.colors[voice.id] = voiceColor(voice, index)
    const windows: TimeWindow[] =
      voice.samples.length > 0 ? voice.samples : voice.fallback ? [voice.fallback] : []
    for (const window of windows) {
      const start = round2(Math.max(0, window.start))
      const end = round2(Math.min(limitOf(duration), window.end))
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        result.snippets.push({ id: voice.id, name, start, end })
      }
    }
  })
  return result
}
