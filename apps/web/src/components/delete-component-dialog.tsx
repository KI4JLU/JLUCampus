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
import type { Component } from '@justcampus/shared'
import { useComponentName } from '@/lib/component-name'
import { useDeleteComponent } from '@/lib/queries'
import { toast } from '@/lib/toast'

interface DeleteComponentDialogProps {
  /** The component to delete; `null` closes the dialog. */
  component: Component | null
  onClose: () => void
  /** After the component is gone, e.g. to leave its editor. */
  onDeleted?: () => void
}

export function DeleteComponentDialog({
  component,
  onClose,
  onDeleted
}: DeleteComponentDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const componentName = useComponentName()
  const remove = useDeleteComponent()

  const confirm = (): void => {
    if (!component) return
    remove.mutate(component.id, {
      onSuccess: () => {
        toast({
          variant: 'success',
          title: t('admin.delete.done', { name: componentName(component) })
        })
        onClose()
        onDeleted?.()
      },
      onError: () => toast({ variant: 'error', title: t('admin.delete.failed') })
    })
  }

  return (
    <Dialog open={component !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent closeLabel={t('common.close')}>
        <DialogHeader>
          <DialogTitle>{t('admin.delete.title')}</DialogTitle>
          <DialogDescription>
            {t('admin.delete.description', { name: component ? componentName(component) : '' })}
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
