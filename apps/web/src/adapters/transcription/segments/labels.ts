import { TRANSCRIPTION_AUTO_SPEAKER_LABEL } from '@justcampus/shared'
import { unknownSpeakerNumber } from './blocks'

/**
 * How a stored speaker name shows (T-02, T-28): kiChat's automatic names, `Unbekannt 2` for a
 * stretch without a speaker and `Stimme 2` for an unnamed voice, appear in the UI language; names
 * users typed stay exactly as they are.
 */
export interface SpeakerLabels {
  /** `Unknown 2`. */
  unknown: (n: number) => string
  /** `Voice 2`. */
  voice: (n: number) => string
}

export function speakerLabel(name: string, labels: SpeakerLabels): string {
  const unknown = unknownSpeakerNumber(name)
  if (unknown !== null) return labels.unknown(unknown)
  const voice = TRANSCRIPTION_AUTO_SPEAKER_LABEL.exec(name.trim())
  if (voice?.[1]) return labels.voice(Number(voice[1]))
  return name
}
