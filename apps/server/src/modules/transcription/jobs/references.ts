import { open } from 'node:fs/promises'

import type { TranscriptionSnippet } from '@justcampus/shared'

import type { DiarizationTurn, KnownSpeaker } from './diarization.js'
import { readWavLayout } from './peaks.js'

/**
 * The known voices the final diarisation gets (kiChat's `known_speaker_names` and
 * `known_speaker_references`): for every name the user gave at dispatch, the audio of its sample
 * windows as a WAV data URI, cut from the normalised 16-bit PCM WAV by byte offsets as kiChat's
 * `extractSnippetBase64` cuts its chunks.
 *
 * kiChat sends one window per voice; the mapping dialog here sends all samples of a voice, so the
 * windows of one name go into one reference, in time order, up to `REFERENCE_MAX_SECONDS`.
 * Voices with the same name are one person and share a reference.
 */

/** Seconds of audio one reference carries at most: three of the dialog's five-second samples. */
export const REFERENCE_MAX_SECONDS = 15

/** The windows of each named voice, in first-seen order of the names. */
export function referenceWindows(
  snippets: readonly TranscriptionSnippet[],
  duration: number | null
): Array<{ name: string; windows: Array<{ start: number; end: number }> }> {
  const limit = duration !== null && duration > 0 ? duration : Number.POSITIVE_INFINITY
  const byName = new Map<string, Array<{ start: number; end: number }>>()
  for (const snippet of snippets) {
    const name = snippet.name.trim()
    if (!name) continue
    const start = Math.max(0, snippet.start)
    const end = Math.min(limit, snippet.end)
    const list = byName.get(name) ?? []
    if (end > start) list.push({ start, end })
    byName.set(name, list)
  }
  const voices: Array<{ name: string; windows: Array<{ start: number; end: number }> }> = []
  for (const [name, windows] of byName) {
    let left = REFERENCE_MAX_SECONDS
    const kept: Array<{ start: number; end: number }> = []
    for (const window of [...windows].sort((a, b) => a.start - b.start)) {
      if (left <= 0) break
      const end = Math.min(window.end, window.start + left)
      kept.push({ start: window.start, end })
      left -= end - window.start
    }
    if (kept.length > 0) voices.push({ name, windows: kept })
  }
  return voices
}

/**
 * The names of the final diarisation's voices (`MappingOptions.speakerMapping`), read off the
 * user's sample windows. A diariser that uses the known voices answers them by name, and those
 * names stay. One that ignores them (the HRZ's Speaches with pyannote) numbers its voices anew,
 * and its `SPEAKER_00` need not be the analysis' `SPEAKER_00`: the order may change between runs,
 * which gave each name the other person's speech. So each voice takes the name whose windows it
 * overlaps most. A voice no window overlaps falls back to the analysis' name for its id, unless
 * another voice took that name already; it otherwise becomes the next automatic label.
 */
export function speakerNamesForTurns(
  turns: readonly DiarizationTurn[],
  snippets: readonly TranscriptionSnippet[],
  mapping: Readonly<Record<string, string>>
): Record<string, string> {
  const named = snippets.filter((snippet) => snippet.name.trim() && snippet.end > snippet.start)
  const knownNames = new Set(named.map((snippet) => snippet.name.trim()))
  const overlaps = new Map<string, Map<string, number>>()
  for (const turn of turns) {
    if (knownNames.has(turn.speaker)) continue
    for (const snippet of named) {
      const overlap = Math.min(turn.end, snippet.end) - Math.max(turn.start, snippet.start)
      if (overlap <= 0) continue
      const byName = overlaps.get(turn.speaker) ?? new Map<string, number>()
      const name = snippet.name.trim()
      byName.set(name, (byName.get(name) ?? 0) + overlap)
      overlaps.set(turn.speaker, byName)
    }
  }
  const names: Record<string, string> = {}
  for (const [speaker, byName] of overlaps) {
    let best: string | null = null
    let most = 0
    for (const [name, overlap] of byName) {
      if (overlap > most) {
        most = overlap
        best = name
      }
    }
    if (best) names[speaker] = best
  }
  const taken = new Set(Object.values(names))
  for (const speaker of new Set(turns.map((turn) => turn.speaker))) {
    const name = mapping[speaker]?.trim()
    if (speaker in names || knownNames.has(speaker) || !name || taken.has(name)) continue
    names[speaker] = name
    taken.add(name)
  }
  return names
}

/** A canonical 44-byte header for 16-bit PCM. */
export function wavHeader(dataBytes: number, sampleRate: number, channels: number): Buffer {
  const header = Buffer.alloc(44)
  const blockAlign = channels * 2
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * blockAlign, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataBytes, 40)
  return header
}

/**
 * The references of the named voices from the normalised WAV at `path`; voices whose windows
 * hold no audio are left out, as kiChat leaves out snippets it could not extract.
 */
export async function knownSpeakers(
  path: string,
  snippets: readonly TranscriptionSnippet[],
  duration: number | null
): Promise<KnownSpeaker[]> {
  const voices = referenceWindows(snippets, duration)
  if (voices.length === 0) return []
  const layout = await readWavLayout(path)
  if (!layout) return []
  const blockAlign = layout.channels * 2
  const bytesPerSecond = layout.sampleRate * blockAlign
  const file = await open(path, 'r')
  try {
    const speakers: KnownSpeaker[] = []
    for (const voice of voices) {
      const parts: Buffer[] = []
      for (const window of voice.windows) {
        const align = (seconds: number): number =>
          Math.min(
            layout.dataBytes,
            Math.floor((seconds * bytesPerSecond) / blockAlign) * blockAlign
          )
        const from = align(window.start)
        const length = align(window.end) - from
        if (length <= 0) continue
        const buffer = Buffer.alloc(length)
        const { bytesRead } = await file.read(buffer, 0, length, layout.dataOffset + from)
        if (bytesRead > 0) parts.push(buffer.subarray(0, bytesRead - (bytesRead % blockAlign)))
      }
      const data = Buffer.concat(parts)
      if (data.length === 0) continue
      const wav = Buffer.concat([wavHeader(data.length, layout.sampleRate, layout.channels), data])
      speakers.push({
        name: voice.name,
        reference: `data:audio/wav;base64,${wav.toString('base64')}`
      })
    }
    return speakers
  } finally {
    await file.close()
  }
}
