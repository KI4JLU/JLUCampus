import type { ComponentViewProps } from '../../types'

/**
 * Dashboard widgets (stream "recording"): `quick` starts a transcription and counts the running
 * ones, `recent` lists the newest saved transcripts (see `COMPONENT_WIDGETS.transcription`).
 */

export function QuickTile(props: ComponentViewProps<'transcription'>): React.JSX.Element | null {
  void props
  return null
}

export function RecentTile(props: ComponentViewProps<'transcription'>): React.JSX.Element | null {
  void props
  return null
}
