import { TRANSCRIPTION_SPEAKER_COLORS, type TranscriptionSpeakerColorId } from '@justcampus/shared'

/**
 * A speaker's colour as kiChat's avatar shows it: a filled circle of one of the ten speaker
 * colours (T-25). The name always stands next to it, so colour is never the only cue.
 */
export function SpeakerDot({
  colorId
}: {
  colorId: TranscriptionSpeakerColorId
}): React.JSX.Element {
  return (
    // DS gap: no categorical palette of ten colours and no coloured avatar; the shared speaker colours fill a plain circle.
    <span
      aria-hidden="true"
      className="block size-5 shrink-0 rounded-full"
      style={{ backgroundColor: TRANSCRIPTION_SPEAKER_COLORS[colorId] }}
    />
  )
}
