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
import { useDeleteAnnouncement, useResetAnnouncement } from '@/lib/queries'
import { toast } from '@/lib/toast'

/** An announcement to confirm an action for, with its title in the admin's UI language. */
export interface AnnouncementTarget {
  id: string
  title: string
}

interface AnnouncementDialogProps {
  /** The announcement; `null` closes the dialog. */
  target: AnnouncementTarget | null
  onClose: () => void
  /** Where the focus goes as the dialog closes; see Radix' `onCloseAutoFocus`. */
  onCloseAutoFocus?: (event: Event) => void
}

/** Confirms deleting an announcement, which also forgets who has seen it. */
export function DeleteAnnouncementDialog({
  target,
  onClose,
  onCloseAutoFocus,
  onDeleted
}: AnnouncementDialogProps & {
  /** After the announcement is gone, e.g. to leave its editor. */
  onDeleted?: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const remove = useDeleteAnnouncement()

  const confirm = (): void => {
    if (!target) return
    remove.mutate(target.id, {
      onSuccess: () => {
        toast({
          variant: 'success',
          title: t('admin.announcements.delete.done', { title: target.title })
        })
        onClose()
        onDeleted?.()
      },
      onError: () => toast({ variant: 'error', title: t('admin.announcements.delete.failed') })
    })
  }

  return (
    <Dialog open={target !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent closeLabel={t('common.close')} onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{t('admin.announcements.delete.title')}</DialogTitle>
          <DialogDescription>
            {t('admin.announcements.delete.description', { title: target?.title ?? '' })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button variant="destructive" disabled={remove.isPending} onClick={confirm}>
            {t('common.delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Confirms showing an announcement again to everyone, including those who closed it. */
export function ResetAnnouncementDialog({
  target,
  onClose,
  onCloseAutoFocus
}: AnnouncementDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const reset = useResetAnnouncement()

  const confirm = (): void => {
    if (!target) return
    reset.mutate(target.id, {
      onSuccess: () => {
        toast({
          variant: 'success',
          title: t('admin.announcements.reset.done', { title: target.title })
        })
        onClose()
      },
      onError: () => toast({ variant: 'error', title: t('admin.announcements.reset.failed') })
    })
  }

  return (
    <Dialog open={target !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent closeLabel={t('common.close')} onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{t('admin.announcements.reset.title')}</DialogTitle>
          <DialogDescription>
            {t('admin.announcements.reset.description', { title: target?.title ?? '' })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary">{t('common.cancel')}</Button>
          </DialogClose>
          <Button disabled={reset.isPending} onClick={confirm}>
            {t('admin.announcements.reset.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
