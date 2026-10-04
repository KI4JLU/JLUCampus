import { Fragment } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@ki4jlu/design-system'
import type { DialogRequest } from './use-dialog-host'

/** The queue's confirmation or message (`useDialogHost`). */
export function UploadDialog({
  request,
  onClose
}: {
  request: DialogRequest | null
  onClose: (confirmed: boolean) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Dialog open={request !== null} onOpenChange={(next) => (next ? undefined : onClose(false))}>
      <DialogContent closeLabel={t('transcription.common.close')}>
        <DialogHeader>
          <DialogTitle>{request?.title}</DialogTitle>
          <DialogDescription>
            <MessageLines text={request?.message ?? ''} />
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          {request?.kind === 'confirm' ? (
            <>
              <DialogClose asChild>
                <Button type="button" variant="secondary">
                  {t('transcription.common.cancel')}
                </Button>
              </DialogClose>
              <Button type="button" variant="destructive" onClick={() => onClose(true)}>
                {request.confirmLabel}
              </Button>
            </>
          ) : (
            <Button type="button" onClick={() => onClose(true)}>
              {t('transcription.common.close')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** A message with its line breaks, as the catalog's alert has them (T-04). */
function MessageLines({ text }: { text: string }): React.JSX.Element {
  return (
    <>
      {text.split('\n').map((line, index) => (
        <Fragment key={index}>
          {index > 0 ? <br /> : null}
          {line}
        </Fragment>
      ))}
    </>
  )
}
