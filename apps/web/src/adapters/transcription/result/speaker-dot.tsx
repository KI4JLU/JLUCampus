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
    // DS gap: `Avatar` paints its circle `bg-primary-container` and takes no colour, and the DS has
    // no categorical palette; T-25/T-28 need the ten user-chosen speaker colours that the waveform
    // and the exports share, so a plain circle carries them until the DS has a coloured avatar.
    <span
      aria-hidden="true"
      className="block size-5 shrink-0 rounded-full"
      style={{ backgroundColor: TRANSCRIPTION_SPEAKER_COLORS[colorId] }}
    />
  )
}
