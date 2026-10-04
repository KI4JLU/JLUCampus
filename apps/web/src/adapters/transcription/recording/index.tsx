import type { ReactNode } from 'react'

/**
 * Recording (stream "recording"): microphone permission and devices, regular recording with WAV
 * conversion, the recorded takes and their upload into one queue group (T-55 to T-58).
 */

/**
 * Holds the microphone choice and the recorded takes for as long as the page lives, so both
 * survive switching between recording, live transcription and other views.
 */
export function RecordingProvider({ children }: { children: ReactNode }): React.JSX.Element {
  return <>{children}</>
}

/** The work area of the `record` view, with the tabs to live transcription. */
export function RecordView(): React.JSX.Element | null {
  return null
}

/** The side column of the `record` view: the microphone. */
export function RecordingSettings(): React.JSX.Element | null {
  return null
}
