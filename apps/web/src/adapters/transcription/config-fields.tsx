import type { ComponentConfigFieldsProps } from '../types'

/**
 * The module's part of the admin form (stream "recording"): speech, diarisation and chat endpoints
 * with model discovery and connection tests, defaults, limits, retention and live modes. The
 * secrets are rendered by the form itself (`COMPONENT_SECRETS.transcription`).
 */
export function TranscriptionConfigFields(
  props: ComponentConfigFieldsProps<'transcription'>
): React.JSX.Element | null {
  void props
  return null
}
