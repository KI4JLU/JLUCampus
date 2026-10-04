/**
 * Speaker mapping (stream "upload"): the dialog that names the analysed voices, picks their
 * colours, plays and edits their samples, adds and removes voices (T-17 to T-21).
 */

export interface SpeakerMappingDialogProps {
  /** The job whose voices are named; `null` keeps the dialog closed. */
  jobId: string | null
  onOpenChange: (open: boolean) => void
}

export function SpeakerMappingDialog(props: SpeakerMappingDialogProps): React.JSX.Element | null {
  void props
  return null
}
