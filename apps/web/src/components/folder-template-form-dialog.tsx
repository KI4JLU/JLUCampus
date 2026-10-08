import { useId, useMemo, useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowDownIcon, ArrowUpIcon, XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Badge,
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
  Label,
  Switch
} from '@ki4jlu/design-system'
import {
  FOLDER_TITLE_MAX,
  widgetRefKey,
  type FolderTemplate,
  type WidgetRef
} from '@justcampus/shared'
import { externalUrlOf } from '@/adapters/registry'
import type { FieldErrors } from '@/lib/component-form'
import { useComponentName } from '@/lib/component-name'
import {
  folderTemplateServerErrors,
  initialFolderTemplateState,
  validateFolderTemplateForm,
  type FolderTemplateFormState
} from '@/lib/folder-template-form'
import {
  adminComponentsQuery,
  useCreateFolderTemplate,
  useUpdateFolderTemplate
} from '@/lib/queries'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { widgetsOfComponent, type ComponentWidget } from '@/lib/widgets'
import { ComponentIcon } from './component-icon'
import { Field } from './field'
import { IconPicker } from './icon-picker'
import { Alert, AlertDescription } from './ui/alert'

interface FolderTemplateFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The template to edit; `null` creates a new one. */
  template: FolderTemplate | null
}

const ICON = { 'aria-hidden': true, width: '1em', height: '1em' } as const

/**
 * Name, icon and widgets of a folder template. Every component's widgets can
 * be picked, disabled ones included. A ticked widget goes to the end of the
 * folder; the order list below moves it. Remounted per template by the caller
 * (`key`), so the form starts from its values.
 */
export function FolderTemplateFormDialog({
  open,
  onOpenChange,
  template
}: FolderTemplateFormDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const componentName = useComponentName()
  const formId = useId()
  const catalogue = useQuery(adminComponentsQuery)
  const [state, setState] = useState<FolderTemplateFormState>(() =>
    initialFolderTemplateState(template)
  )
  const [errors, setErrors] = useState<FieldErrors>({})
  const [failed, setFailed] = useState(false)
  const create = useCreateFolderTemplate()
  const update = useUpdateFolderTemplate()
  const pending = create.isPending || update.isPending

  const widgets = useMemo(() => catalogue.data?.flatMap(widgetsOfComponent), [catalogue.data])
  const widgetsByKey = useMemo(
    () => new Map((widgets ?? []).map((widget) => [widgetRefKey(widget), widget])),
    [widgets]
  )
  // Widgets of a component deleted while the dialog is open drop out rather than failing the save.
  const chosen = widgets
    ? state.widgets.filter((ref) => widgetsByKey.has(widgetRefKey(ref)))
    : state.widgets

  const set = <K extends keyof FolderTemplateFormState>(
    key: K,
    value: FolderTemplateFormState[K]
  ): void => setState((current) => ({ ...current, [key]: value }))

  const setWidgets = (change: (refs: WidgetRef[]) => WidgetRef[]): void =>
    setState((current) => ({ ...current, widgets: change(current.widgets) }))
  const toggle = (widget: WidgetRef, checked: boolean): void =>
    setWidgets((refs) => {
      const key = widgetRefKey(widget)
      const without = refs.filter((entry) => widgetRefKey(entry) !== key)
      const { componentId, widgetKey } = widget
      return checked ? [...without, { componentId, widgetKey }] : without
    })
  const move = (key: string, offset: -1 | 1): void =>
    setWidgets((refs) => {
      const index = refs.findIndex((entry) => widgetRefKey(entry) === key)
      const moved = refs[index]
      const other = refs[index + offset]
      if (moved === undefined || other === undefined) return refs
      const next = [...refs]
      next[index + offset] = moved
      next[index] = other
      return next
    })

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    setFailed(false)
    const result = validateFolderTemplateForm({ ...state, widgets: chosen }, t)
    if (!result.ok) {
      setErrors(result.errors)
      return
    }
    setErrors({})
    const options = {
      onSuccess: () => {
        toast({
          variant: 'success',
          title: t(template ? 'admin.folders.form.updated' : 'admin.folders.form.created')
        })
        onOpenChange(false)
      },
      onError: (error: Error) => {
        const fieldErrors = folderTemplateServerErrors(error, t)
        if (fieldErrors) setErrors(fieldErrors)
        else setFailed(true)
      }
    }
    if (template) update.mutate({ id: template.id, input: result.input }, options)
    else create.mutate(result.input, options)
  }

  const widgetsErrorId = errors.widgets ? `${formId}-widgets-error` : undefined

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t('common.close')} className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {template ? t('admin.folders.form.editTitle') : t('admin.folders.form.createTitle')}
          </DialogTitle>
          <DialogDescription>{t('admin.folders.form.description')}</DialogDescription>
        </DialogHeader>
        <form noValidate onSubmit={handleSubmit} className="flex flex-col gap-stack-md">
          {failed || errors.form ? (
            <Alert variant="destructive">
              <AlertDescription>
                {errors.form ?? t('admin.folders.form.saveFailed')}
              </AlertDescription>
            </Alert>
          ) : null}
          <Field id={`${formId}-name`} label={t('admin.folders.form.name')} error={errors.name}>
            {(control) => (
              <Input
                {...control}
                value={state.name}
                maxLength={FOLDER_TITLE_MAX}
                required
                onChange={(event) => set('name', event.target.value)}
              />
            )}
          </Field>
          <Field
            id={`${formId}-icon`}
            label={t('admin.folders.form.icon')}
            hint={t('admin.folders.form.iconHint')}
            error={errors.icon}
          >
            {(control) => (
              <IconPicker {...control} value={state.icon} onChange={(icon) => set('icon', icon)} />
            )}
          </Field>
          <fieldset
            aria-describedby={widgetsErrorId}
            className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0"
          >
            <legend
              className={cn(
                'mb-2 text-sm font-medium text-on-surface',
                errors.widgets && 'text-error'
              )}
            >
              {t('admin.folders.form.widgets')}
            </legend>
            {errors.widgets ? (
              <p id={widgetsErrorId} className="m-0 text-sm text-error">
                {errors.widgets}
              </p>
            ) : null}
            {catalogue.isPending ? (
              <p className="m-0 text-sm text-on-surface-variant">{t('common.loading')}</p>
            ) : catalogue.isError ? (
              <Alert variant="destructive">
                <AlertDescription>{t('admin.loadFailed')}</AlertDescription>
              </Alert>
            ) : !widgets || widgets.length === 0 ? (
              <p className="m-0 text-sm text-on-surface-variant">{t('admin.table.empty')}</p>
            ) : (
              <ul className="m-0 flex max-h-60 list-none flex-col gap-1 overflow-y-auto p-0">
                {widgets.map((widget) => {
                  const key = widgetRefKey(widget)
                  const id = `${formId}-widget-${widget.componentId}-${widget.widgetKey}`
                  return (
                    <li key={key} className="flex items-center gap-3 rounded-md px-2 py-1.5">
                      <Checkbox
                        id={id}
                        checked={chosen.some((ref) => widgetRefKey(ref) === key)}
                        onCheckedChange={(checked) => toggle(widget, checked === true)}
                      />
                      <Label htmlFor={id} className="flex min-w-0 flex-1 items-center gap-2">
                        <WidgetLabel widget={widget} />
                      </Label>
                    </li>
                  )
                })}
              </ul>
            )}
          </fieldset>
          <section aria-labelledby={`${formId}-order`} className="flex flex-col gap-2">
            <h3 id={`${formId}-order`} className="m-0 text-sm font-medium text-on-surface">
              {t('admin.folders.form.order')}
            </h3>
            {chosen.length === 0 ? (
              <p className="m-0 text-sm text-on-surface-variant">
                {t('admin.folders.form.orderEmpty')}
              </p>
            ) : (
              <ol className="m-0 flex list-none flex-col gap-1 p-0">
                {chosen.map((ref, index) => {
                  const key = widgetRefKey(ref)
                  const widget = widgetsByKey.get(key)
                  const name = widget ? componentName(widget.component) : key
                  return (
                    <li key={key} className="flex items-center gap-2 rounded-md py-0.5 pl-2">
                      <span className="w-6 shrink-0 text-right text-sm text-on-surface-variant tabular-nums">
                        {index + 1}.
                      </span>
                      <span className="flex min-w-0 flex-1 items-center gap-2 text-sm text-on-surface">
                        {widget ? <WidgetLabel widget={widget} /> : name}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={index === 0}
                        aria-label={t('admin.table.moveUp', { name })}
                        onClick={() => move(key, -1)}
                      >
                        <ArrowUpIcon {...ICON} />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        disabled={index === chosen.length - 1}
                        aria-label={t('admin.table.moveDown', { name })}
                        onClick={() => move(key, 1)}
                      >
                        <ArrowDownIcon {...ICON} />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={t('admin.folders.form.removeWidget', { name })}
                        onClick={() => toggle(ref, false)}
                      >
                        <XIcon {...ICON} />
                      </Button>
                    </li>
                  )
                })}
              </ol>
            )}
          </section>
          <div className="flex items-center justify-between gap-stack-md">
            <Label htmlFor={`${formId}-enabled`}>{t('admin.folders.form.enabled')}</Label>
            <Switch
              id={`${formId}-enabled`}
              checked={state.enabled}
              onCheckedChange={(checked) => set('enabled', checked)}
            />
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="secondary">
                {t('common.cancel')}
              </Button>
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending ? t('common.saving') : t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * A widget's icon and name, both its component's. Widgets of disabled
 * components say so, users will not see them in the folder.
 */
function WidgetLabel({ widget }: { widget: ComponentWidget }): React.JSX.Element {
  const { t } = useTranslation()
  const componentName = useComponentName()
  const { component } = widget
  return (
    <>
      <ComponentIcon
        icon={component.icon}
        iconUrl={component.iconUrl}
        siteUrl={externalUrlOf(component)}
      />
      <span className="truncate">{componentName(component)}</span>
      {component.enabled ? null : (
        <Badge tone="neutral" appearance="filled" className="shrink-0">
          {t('admin.folders.form.widgetDisabled')}
        </Badge>
      )}
    </>
  )
}
