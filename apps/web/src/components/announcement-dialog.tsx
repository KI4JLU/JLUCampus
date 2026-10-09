import { lazy, Suspense, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Spinner
} from '@ki4jlu/design-system'

const MarkdownView = lazy(() => import('./markdown-view'))

interface AnnouncementDialogProps {
  open: boolean
  /** Escape, the close button and a click beside the dialog ask to close it. */
  onClose: () => void
  /** The small line above the title, e.g. the date or a badge; it describes the dialog. */
  meta: ReactNode
  title: string
  /** Markdown; `null` for a dialog with nothing to read but its title and meta line. */
  body: string | null
  /** After the text, e.g. a note or a live region. */
  children?: ReactNode
  /** The buttons. */
  footer: ReactNode
  onCloseAutoFocus?: (event: Event) => void
  /** Attributes for the dialog's frame, e.g. the hint marker. */
  frameProps?: Record<`data-${string}`, string>
}

/** One announcement in a dialog: meta line, title and text, then the buttons. */
export function AnnouncementDialog({
  open,
  onClose,
  meta,
  title,
  body,
  children,
  footer,
  onCloseAutoFocus,
  frameProps
}: AnnouncementDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent
        closeLabel={t('common.close')}
        onCloseAutoFocus={onCloseAutoFocus}
        {...frameProps}
      >
        <DialogHeader>
          <DialogDescription>{meta}</DialogDescription>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {body !== null ? (
          // Long texts scroll inside the dialog; the buttons stay in view.
          <div className="max-h-96 overflow-y-auto">
            <Suspense fallback={<Spinner label={t('common.loading')} />}>
              <MarkdownView markdown={body} breaks headingOffset={2} />
            </Suspense>
          </div>
        ) : null}
        {children}
        <DialogFooter>{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
