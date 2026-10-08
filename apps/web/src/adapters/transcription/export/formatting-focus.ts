/** The side column's transcript formatting, which the preview's "Ändern" moves to. */
export const TRANSCRIPT_FORMATTING_ID = 'transcription-export-formatting'

/**
 * Moves the focus to the format in use in the side column (kiChat's "Ändern" opens its
 * formatting view; here the settings stay in the side column).
 */
export function focusTranscriptFormatting(): void {
  const section = document.getElementById(TRANSCRIPT_FORMATTING_ID)
  const target =
    section?.querySelector<HTMLElement>('[aria-current="true"]') ??
    section?.querySelector<HTMLElement>('button')
  target?.focus()
  target?.scrollIntoView({ block: 'nearest' })
}
