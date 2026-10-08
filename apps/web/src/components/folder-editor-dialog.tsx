import { useState, type FormEvent } from 'react'
import { XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Checkbox,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label
} from '@ki4jlu/design-system'
import {
  FOLDER_TITLE_MAX,
  widgetRefKey,
  type FolderItem,
  type FolderLinkItem,
  type FolderTile,
  type WidgetRef
} from '@justcampus/shared'
import { externalUrlOf } from '@/adapters/registry'
import { useComponentName } from '@/lib/component-name'
import { hostnameOf } from '@/lib/links'
import type { ComponentWidget } from '@/lib/widgets'
import { ComponentIcon } from './component-icon'
import { Field } from './field'
import { IconPicker } from './icon-picker'
import { SiteIcon } from './site-icon'

interface FolderEditorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tile: FolderTile
  /** Every widget of every enabled component, in catalogue order. */
  widgets: ComponentWidget[]
  onSave: (tile: FolderTile) => void
}

/**
 * Name, icon and contents of a folder. A newly ticked widget goes to the end of the
 * folder; shortcuts come in by dragging and can be taken out here.
 */
export function FolderEditorDialog({
  open,
  onOpenChange,
  tile,
  widgets,
  onSave
}: FolderEditorDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const componentName = useComponentName()
  const [title, setTitle] = useState(tile.title)
  const [icon, setIcon] = useState<string | null>(tile.icon ?? null)
  const [items, setItems] = useState<FolderItem[]>(tile.items)
  const [error, setError] = useState<string | undefined>(undefined)
  const links = items.filter((item): item is FolderLinkItem => item.kind === 'link')
  const hasWidget = (key: string): boolean =>
    items.some((item) => item.kind === 'widget' && widgetRefKey(item) === key)

  const toggle = (widget: WidgetRef, checked: boolean): void =>
    setItems((current) => {
      const key = widgetRefKey(widget)
      const without = current.filter((item) => item.kind !== 'widget' || widgetRefKey(item) !== key)
      const { componentId, widgetKey } = widget
      return checked ? [...without, { kind: 'widget', componentId, widgetKey }] : without
    })
  const removeLink = (id: string): void =>
    setItems((current) => current.filter((item) => item.kind !== 'link' || item.id !== id))

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const trimmed = title.trim()
    if (trimmed.length === 0 || trimmed.length > FOLDER_TITLE_MAX) {
      setError(t('dashboard.folder.titleError', { max: FOLDER_TITLE_MAX }))
      return
    }
    onSave({ ...tile, title: trimmed, icon, items })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t('common.close')} className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('dashboard.folder.editTitle')}</DialogTitle>
          <DialogDescription>{t('dashboard.folder.editDescription')}</DialogDescription>
        </DialogHeader>
        <form noValidate onSubmit={handleSubmit} className="flex flex-col gap-stack-md">
          <Field id="folder-title" label={t('dashboard.folder.title')} error={error}>
            {(control) => (
              <Input
                {...control}
                value={title}
                maxLength={FOLDER_TITLE_MAX}
                required
                onChange={(event) => {
                  setTitle(event.target.value)
                  setError(undefined)
                }}
              />
            )}
          </Field>
          <Field
            id="folder-icon"
            label={t('dashboard.folder.icon')}
            hint={t('dashboard.folder.iconHint')}
          >
            {(control) => <IconPicker {...control} value={icon} onChange={setIcon} />}
          </Field>
          <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
            <legend className="mb-2 text-sm font-medium text-on-surface">
              {t('dashboard.folder.widgets')}
            </legend>
            {widgets.length === 0 ? (
              <p className="m-0 text-sm text-on-surface-variant">
                {t('dashboard.noWidgetsAvailable')}
              </p>
            ) : (
              <ul className="m-0 flex max-h-72 list-none flex-col gap-1 overflow-y-auto p-0">
                {widgets.map((widget) => {
                  const key = widgetRefKey(widget)
                  const id = `folder-widget-${widget.componentId}-${widget.widgetKey}`
                  const { component } = widget
                  return (
                    <li key={key} className="flex items-center gap-3 rounded-md px-2 py-1.5">
                      <Checkbox
                        id={id}
                        checked={hasWidget(key)}
                        onCheckedChange={(checked) => toggle(widget, checked === true)}
                      />
                      <Label htmlFor={id} className="flex min-w-0 flex-1 items-center gap-2">
                        <ComponentIcon
                          icon={component.icon}
                          iconUrl={component.iconUrl}
                          siteUrl={externalUrlOf(component)}
                        />
                        <span className="truncate">{componentName(component)}</span>
                      </Label>
                    </li>
                  )
                })}
              </ul>
            )}
          </fieldset>
          <section aria-labelledby="folder-shortcuts" className="flex flex-col gap-2">
            <h3 id="folder-shortcuts" className="m-0 text-sm font-medium text-on-surface">
              {t('dashboard.folder.shortcuts')}
            </h3>
            {links.length === 0 ? (
              <p className="m-0 text-sm text-on-surface-variant">
                {t('dashboard.folder.noShortcuts')}
              </p>
            ) : (
              <ul className="m-0 flex max-h-56 list-none flex-col gap-1 overflow-y-auto p-0">
                {links.map((link) => (
                  <li key={link.id} className="flex items-center gap-3 rounded-md py-0.5 pl-2">
                    <SiteIcon url={link.url} icon={link.icon} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm text-on-surface">{link.title}</span>
                      <span className="truncate text-xs text-on-surface-variant">
                        {hostnameOf(link.url) ?? link.url}
                      </span>
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={t('dashboard.folder.removeShortcut', { name: link.title })}
                      onClick={() => removeLink(link.id)}
                    >
                      <XIcon aria-hidden="true" width="1em" height="1em" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="secondary">
                {t('common.cancel')}
              </Button>
            </DialogClose>
            <Button type="submit">{t('common.save')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
