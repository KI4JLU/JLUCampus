/**
 * Summary templates (stream "export"): the chooser with built-ins and the user's own, the structure
 * editor with placeholders and AI section previews (T-50 to T-54).
 */

export interface TemplateLibraryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The template chosen with "Use". */
  onChoose: (templateId: string) => void
}

export function TemplateLibraryDialog(props: TemplateLibraryDialogProps): React.JSX.Element | null {
  void props
  return null
}
