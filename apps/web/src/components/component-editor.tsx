import { useId, useRef, useState, type FormEvent } from 'react'
import { flushSync } from 'react-dom'
import { Link, useBlocker, useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowLeftIcon, Trash2Icon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Card,
  Container,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch
} from '@ki4jlu/design-system'
import {
  componentTypeSchema,
  isBuiltInType,
  isDesktopComponentType,
  type AdminComponent
} from '@justcampus/shared'
import { adapterOf, componentAdapters } from '@/adapters/registry'
import {
  configErrors,
  initialFormState,
  isFormDirty,
  selectableTypes,
  serverFieldErrors,
  validateComponentForm,
  type ComponentFormState,
  type FieldErrors
} from '@/lib/component-form'
import { isSecretSet, secretKeysOf } from '@/lib/component-secrets'
import { queryKeys, useCreateComponent, useUpdateComponent } from '@/lib/queries'
import { toast } from '@/lib/toast'
import { AdminNav } from './admin-nav'
import { DeleteComponentDialog } from './delete-component-dialog'
import { Field } from './field'
import { FormSection } from './form-section'
import { IconPicker } from './icon-picker'
import { PageHeader } from './page-header'
import { SecretField } from './secret-field'
import { Alert, AlertDescription } from './ui/alert'

const ICON = { 'aria-hidden': true, width: '1em', height: '1em' } as const

/** Every navigation away is a candidate; `disabled` lets them through while nothing is unsaved. */
const BLOCK_NAVIGATION = (): boolean => true

interface ComponentEditorProps {
  /** The component as saved; `null` creates a new one. */
  component: AdminComponent | null
}

/**
 * The admin's page for one component: its general fields, its credentials and the type's
 * configuration, one card each, under a save bar that stays in view. Leaving the page (in the
 * app or the browser) with unsaved changes asks first.
 */
export function ComponentEditor({ component }: ComponentEditorProps): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const client = useQueryClient()
  const formId = useId()
  const formRef = useRef<HTMLFormElement>(null)
  // The values as loaded or last saved; the form has unsaved changes while it differs from them.
  const [baseline, setBaseline] = useState<ComponentFormState>(() => initialFormState(component))
  const [state, setState] = useState<ComponentFormState>(baseline)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [failed, setFailed] = useState(false)
  const [deleting, setDeleting] = useState<AdminComponent | null>(null)
  const create = useCreateComponent()
  const update = useUpdateComponent()
  const pending = create.isPending || update.isPending
  const blocker = useBlocker({
    shouldBlockFn: BLOCK_NAVIGATION,
    disabled: !isFormDirty(state, baseline),
    withResolver: true
  })
  const adapter = adapterOf(state.type)
  // Built-in components (modules, desktop components) keep their type and cannot be deleted.
  const isBuiltIn = component !== null && isBuiltInType(component.type)
  const types = selectableTypes(component)
  const secretKeys = secretKeysOf(state.type)

  const set = <K extends keyof ComponentFormState>(key: K, value: ComponentFormState[K]): void =>
    setState((current) => ({ ...current, [key]: value }))

  /**
   * On a long page the first error may be out of view: the admin is taken to it, a field or a
   * group of fields (a model list) whose error describes it.
   */
  const showErrors = (next: FieldErrors): void => {
    flushSync(() => setErrors(next))
    formRef.current
      ?.querySelector<HTMLElement>('[aria-invalid="true"], fieldset[aria-describedby*="-error"]')
      ?.focus()
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    setFailed(false)
    const result = validateComponentForm(state, t)
    if (!result.ok) {
      showErrors(result.errors)
      return
    }
    setErrors({})
    // Edits made while the save runs stay, as unsaved changes on top of the saved values.
    const submitted = state
    const onError = (error: Error): void => {
      const fieldErrors = serverFieldErrors(error, state.type, t)
      if (fieldErrors) showErrors(fieldErrors)
      else setFailed(true)
    }
    if (component) {
      update.mutate(
        { id: component.id, input: result.input },
        {
          onSuccess: (saved) => {
            client.setQueryData(queryKeys.adminComponent(saved.id), saved)
            // The server's copy is the new baseline, typed secrets now count as saved.
            const next = initialFormState(saved)
            setBaseline(next)
            setState((current) => (current === submitted ? next : current))
            toast({ variant: 'success', title: t('admin.form.updated') })
          },
          onError
        }
      )
    } else {
      create.mutate(result.input, {
        onSuccess: (created) => {
          toast({ variant: 'success', title: t('admin.form.created') })
          // Saved: the new component's own page takes over and loads it fresh. Staying on this
          // page for edits typed meanwhile would create the component a second time on save.
          void navigate({
            to: '/admin/components/$componentId',
            params: { componentId: created.id },
            replace: true,
            ignoreBlocker: true
          })
        },
        onError
      })
    }
  }

  return (
    <Container className="flex flex-col gap-gutter py-gutter md:py-margin-page">
      <PageHeader
        title={
          component
            ? t('admin.form.editTitle', { name: component.name })
            : t('admin.form.createTitle')
        }
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to="/admin/components">
                <ArrowLeftIcon {...ICON} />
                {t('admin.form.back')}
              </Link>
            </Button>
            {component && !isBuiltIn ? (
              <Button variant="ghost-destructive" onClick={() => setDeleting(component)}>
                <Trash2Icon {...ICON} />
                {t('common.delete')}
              </Button>
            ) : null}
          </>
        }
      />
      <AdminNav />
      <form ref={formRef} noValidate onSubmit={handleSubmit} className="flex flex-col gap-gutter">
        <FormSection title={t('admin.form.general')} description={t('admin.form.description')}>
          <div className="grid items-start gap-stack-md md:grid-cols-2">
            <Field
              id={`${formId}-type`}
              label={t('admin.form.type')}
              hint={
                !isBuiltIn
                  ? undefined
                  : isDesktopComponentType(state.type)
                    ? t('admin.form.desktopTypeHint')
                    : t('admin.form.moduleTypeHint')
              }
              error={errors.type}
            >
              {(control) => (
                <Select
                  value={state.type}
                  disabled={isBuiltIn}
                  onValueChange={(value) => {
                    const type = componentTypeSchema.parse(value)
                    setState((current) => ({
                      ...current,
                      type,
                      config: componentAdapters[type].defaultConfig,
                      secrets: {}
                    }))
                  }}
                >
                  <SelectTrigger {...control}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {types.map((type) => (
                      <SelectItem key={type} value={type}>
                        {t(`componentTypes.${type}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>
            <Field id={`${formId}-name`} label={t('admin.form.name')} error={errors.name}>
              {(control) => (
                <Input
                  {...control}
                  value={state.name}
                  maxLength={80}
                  required
                  onChange={(event) => set('name', event.target.value)}
                />
              )}
            </Field>
            <Field
              id={`${formId}-icon`}
              label={t('admin.form.icon')}
              hint={t('admin.form.iconHint')}
              error={errors.icon}
            >
              {(control) => (
                <IconPicker
                  {...control}
                  value={state.icon}
                  onChange={(icon) => set('icon', icon)}
                />
              )}
            </Field>
            <Field
              id={`${formId}-icon-url`}
              label={t('admin.form.iconUrl')}
              hint={t('admin.form.iconUrlHint')}
              error={errors.iconUrl}
            >
              {(control) => (
                <Input
                  {...control}
                  type="url"
                  inputMode="url"
                  placeholder="https://"
                  value={state.iconUrl}
                  onChange={(event) => set('iconUrl', event.target.value)}
                />
              )}
            </Field>
          </div>
          <div className="flex items-center justify-between gap-stack-md">
            <Label htmlFor={`${formId}-enabled`}>{t('admin.form.enabled')}</Label>
            <Switch
              id={`${formId}-enabled`}
              checked={state.enabled}
              onCheckedChange={(checked) => set('enabled', checked)}
            />
          </div>
        </FormSection>
        {secretKeys.length > 0 ? (
          <FormSection
            title={t('admin.form.credentials')}
            description={t('admin.form.credentialsDescription')}
          >
            {secretKeys.map((secret) => (
              <SecretField
                key={`${state.type}-${secret}`}
                id={`${formId}-secret-${secret}`}
                type={state.type}
                secret={secret}
                isSet={component?.type === state.type && isSecretSet(component, secret)}
                draft={state.secrets[secret]}
                onChange={(draft) =>
                  setState((current) => ({
                    ...current,
                    secrets: { ...current.secrets, [secret]: draft }
                  }))
                }
                error={errors[`secrets.${secret}`]}
              />
            ))}
          </FormSection>
        ) : null}
        <adapter.ConfigFields
          config={state.config}
          onChange={(config) => set('config', config)}
          errors={configErrors(errors)}
          secrets={state.secrets}
          idPrefix={formId}
        />
        {/* DS gap: no sticky action bar for long forms; a Card held at the foot of the view stands in. */}
        <Card className="sticky bottom-stack-md z-10">
          <div className="flex flex-col gap-stack-sm p-stack-md">
            {failed || errors.form ? (
              <Alert variant="destructive">
                <AlertDescription>{errors.form ?? t('admin.form.saveFailed')}</AlertDescription>
              </Alert>
            ) : null}
            <div className="flex flex-wrap items-center justify-end gap-stack-sm">
              <Button variant="secondary" asChild>
                <Link to="/admin/components">{t('common.cancel')}</Link>
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? t('common.saving') : t('common.save')}
              </Button>
            </div>
          </div>
        </Card>
      </form>
      <DeleteComponentDialog
        component={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={() => void navigate({ to: '/admin/components', ignoreBlocker: true })}
      />
      <Dialog
        open={blocker.status === 'blocked'}
        onOpenChange={(open) => (open ? undefined : blocker.reset?.())}
      >
        <DialogContent closeLabel={t('common.close')}>
          <DialogHeader>
            <DialogTitle>{t('admin.form.unsaved.title')}</DialogTitle>
            <DialogDescription>{t('admin.form.unsaved.description')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => blocker.reset?.()}>
              {t('admin.form.unsaved.stay')}
            </Button>
            <Button variant="destructive" onClick={() => blocker.proceed?.()}>
              {t('admin.form.unsaved.leave')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Container>
  )
}
