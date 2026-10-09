import { useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { flushSync } from 'react-dom'
import { Link, useBlocker, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeftIcon, Trash2Icon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Badge,
  Button,
  Card,
  Container,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FormControl,
  FormDescription,
  FormItem,
  FormLabel,
  Input,
  Label,
  Spinner,
  Switch
} from '@ki4jlu/design-system'
import { ROLE_NAME_MAX, type AdminComponent, type AppRole } from '@justcampus/shared'
import { externalUrlOf } from '@/adapters/registry'
import type { FieldErrors } from '@/lib/component-form'
import { useComponentName } from '@/lib/component-name'
import {
  adminComponentsQuery,
  adminRoleAudiencesQuery,
  useCreateRole,
  useUpdateRole
} from '@/lib/queries'
import {
  featuresByModule,
  initialRoleFormState,
  isRoleFormDirty,
  roleName,
  roleServerErrors,
  validateRoleForm,
  withId,
  type RoleFormState
} from '@/lib/roles'
import { toast } from '@/lib/toast'
import { ComponentIcon } from './component-icon'
import { DeleteRoleDialog } from './delete-role-dialog'
import { Field } from './field'
import { FormSection } from './form-section'
import { KeycloakNamesField } from './keycloak-names-field'
import { PageHeader } from './page-header'
import { Alert, AlertDescription } from './ui/alert'

const ICON = { 'aria-hidden': true, width: '1em', height: '1em' } as const

/** Every navigation away is a candidate; `disabled` lets them through while nothing is unsaved. */
const BLOCK_NAVIGATION = (): boolean => true

interface RoleEditorProps {
  /** The role as saved; `null` creates a new one. */
  role: AppRole | null
}

/**
 * The admin's page for one role: its name, who gets it automatically, and the components and
 * module functions it allows, one card each, under a save bar that stays in view. The everyone
 * role has no automatic assignment (everybody holds it), the admin role no permission cards
 * (admins may do everything). Leaving the page with unsaved changes asks first.
 */
export function RoleEditor({ role }: RoleEditorProps): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const formId = useId()
  const formRef = useRef<HTMLFormElement>(null)
  // The values as loaded or last saved; the form has unsaved changes while it differs from them.
  const [baseline, setBaseline] = useState<RoleFormState>(() => initialRoleFormState(role))
  const [state, setState] = useState<RoleFormState>(baseline)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [failed, setFailed] = useState(false)
  const [deleting, setDeleting] = useState<AppRole | null>(null)
  const components = useQuery(adminComponentsQuery)
  // Optional extra: without suggestions the names are simply typed.
  const suggestions = useQuery(adminRoleAudiencesQuery)
  const create = useCreateRole()
  const update = useUpdateRole()
  const pending = create.isPending || update.isPending
  const blocker = useBlocker({
    shouldBlockFn: BLOCK_NAVIGATION,
    disabled: !isRoleFormDirty(state, baseline),
    withResolver: true
  })
  const builtIn = role?.builtIn ?? null

  const set = <K extends keyof RoleFormState>(key: K, value: RoleFormState[K]): void =>
    setState((current) => ({ ...current, [key]: value }))

  /** On a long page the first error may be out of view: the admin is taken to its field. */
  const showErrors = (next: FieldErrors): void => {
    flushSync(() => setErrors(next))
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    setFailed(false)
    const known = components.data ? new Set(components.data.map((component) => component.id)) : null
    const result = validateRoleForm(state, known, t)
    if (!result.ok) {
      showErrors(result.errors)
      return
    }
    setErrors({})
    // Edits made while the save runs stay, as unsaved changes on top of the saved values.
    const submitted = state
    const onError = (error: Error): void => {
      const fieldErrors = roleServerErrors(error, t)
      if (fieldErrors) showErrors(fieldErrors)
      else setFailed(true)
    }
    if (role) {
      update.mutate(
        { id: role.id, input: result.input },
        {
          onSuccess: (saved) => {
            const next = initialRoleFormState(saved)
            setBaseline(next)
            setState((current) => (current === submitted ? next : current))
            toast({ variant: 'success', title: t('admin.roles.form.updated') })
          },
          onError
        }
      )
    } else {
      create.mutate(result.input, {
        onSuccess: (created) => {
          toast({ variant: 'success', title: t('admin.roles.form.created') })
          // Saved: the new role's own page takes over. Staying here for edits typed meanwhile
          // would create the role a second time on save.
          void navigate({
            to: '/admin/roles/$roleId',
            params: { roleId: created.id },
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
          role
            ? t('admin.roles.form.editTitle', { name: roleName(role, t) })
            : t('admin.roles.form.createTitle')
        }
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to="/admin/roles">
                <ArrowLeftIcon {...ICON} />
                {t('admin.roles.form.back')}
              </Link>
            </Button>
            {role && !builtIn ? (
              <Button variant="ghost-destructive" onClick={() => setDeleting(role)}>
                <Trash2Icon {...ICON} />
                {t('common.delete')}
              </Button>
            ) : null}
          </>
        }
      />
      <form ref={formRef} noValidate onSubmit={handleSubmit} className="flex flex-col gap-gutter">
        <FormSection
          title={t('admin.roles.form.general')}
          description={
            builtIn === 'everyone'
              ? t('admin.roles.form.everyoneDescription')
              : builtIn === 'admin'
                ? t('admin.roles.form.adminDescription')
                : t('admin.roles.form.description')
          }
        >
          <Field
            id={`${formId}-name`}
            label={t('admin.roles.form.name')}
            hint={builtIn ? t('admin.roles.form.builtInNameHint') : undefined}
            error={errors.name}
          >
            {(control) =>
              role && builtIn ? (
                <Input {...control} value={roleName(role, t)} readOnly />
              ) : (
                <Input
                  {...control}
                  value={state.name}
                  maxLength={ROLE_NAME_MAX}
                  required
                  onChange={(event) => set('name', event.target.value)}
                />
              )
            }
          </Field>
        </FormSection>
        {builtIn === 'everyone' ? null : (
          <FormSection
            title={t('admin.roles.form.automatic')}
            description={t('admin.roles.form.automaticDescription')}
          >
            <div className="grid items-start gap-stack-md md:grid-cols-2">
              <KeycloakNamesField
                id={`${formId}-keycloak-roles`}
                label={t('admin.roles.form.keycloakRoles')}
                hint={t('admin.roles.form.keycloakRolesHint')}
                error={errors.keycloakRoles}
                names={state.keycloakRoles}
                suggestions={suggestions.data?.roles}
                onChange={(names) => set('keycloakRoles', names)}
              />
              <KeycloakNamesField
                id={`${formId}-keycloak-groups`}
                label={t('admin.roles.form.keycloakGroups')}
                hint={t('admin.roles.form.keycloakGroupsHint')}
                error={errors.keycloakGroups}
                names={state.keycloakGroups}
                suggestions={suggestions.data?.groups}
                onChange={(names) => set('keycloakGroups', names)}
              />
            </div>
          </FormSection>
        )}
        {builtIn === 'admin' ? (
          <FormSection
            title={t('admin.roles.form.permissions')}
            description={t('admin.roles.form.adminPermissions')}
          />
        ) : (
          <>
            <ComponentsSection
              idPrefix={formId}
              components={components.data}
              failed={components.isError}
              error={errors.componentIds}
              selected={state.componentIds}
              onChange={(ids) => set('componentIds', ids)}
            />
            <FeaturesSection
              idPrefix={formId}
              components={components.data}
              selected={state.features}
              onChange={(features) => set('features', features)}
            />
          </>
        )}
        {/* DS gap: no sticky action bar for long forms; a Card held at the foot of the view stands in. */}
        <Card className="sticky bottom-stack-md z-10">
          <div className="flex flex-col gap-stack-sm p-stack-md">
            {failed || errors.form ? (
              <Alert variant="destructive">
                <AlertDescription>
                  {errors.form ?? t('admin.roles.form.saveFailed')}
                </AlertDescription>
              </Alert>
            ) : null}
            <div className="flex flex-wrap items-center justify-end gap-stack-sm">
              <Button variant="secondary" asChild>
                <Link to="/admin/roles">{t('common.cancel')}</Link>
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? t('common.saving') : t('common.save')}
              </Button>
            </div>
          </div>
        </Card>
      </form>
      <DeleteRoleDialog
        role={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={() => void navigate({ to: '/admin/roles', ignoreBlocker: true })}
      />
      <Dialog
        open={blocker.status === 'blocked'}
        onOpenChange={(open) => (open ? undefined : blocker.reset?.())}
      >
        <DialogContent closeLabel={t('common.close')}>
          <DialogHeader>
            <DialogTitle>{t('admin.form.unsaved.title')}</DialogTitle>
            <DialogDescription>{t('admin.roles.form.unsavedDescription')}</DialogDescription>
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

interface ComponentsSectionProps {
  idPrefix: string
  /** The catalogue, disabled components too; `undefined` while it loads or when it failed. */
  components: AdminComponent[] | undefined
  failed: boolean
  error?: string
  selected: readonly string[]
  onChange: (ids: string[]) => void
}

/** One switch per component of the catalogue, with shortcuts for all and none. */
function ComponentsSection({
  idPrefix,
  components,
  failed,
  error,
  selected,
  onChange
}: ComponentsSectionProps): React.JSX.Element {
  const { t } = useTranslation()
  const componentName = useComponentName()
  return (
    <FormSection
      title={t('admin.roles.form.components')}
      description={t('admin.roles.form.componentsDescription')}
    >
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {failed ? (
        <Alert variant="destructive">
          <AlertDescription>{t('admin.roles.form.componentsFailed')}</AlertDescription>
        </Alert>
      ) : !components ? (
        <Spinner label={t('common.loading')} className="self-center" />
      ) : components.length === 0 ? (
        <p className="m-0">{t('admin.roles.form.componentsEmpty')}</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-stack-sm">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onChange(components.map((component) => component.id))}
            >
              {t('admin.roles.form.allComponents')}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => onChange([])}>
              {t('admin.roles.form.noComponents')}
            </Button>
          </div>
          <ul className="m-0 flex list-none flex-col gap-stack-sm p-0">
            {components.map((component) => {
              const id = `${idPrefix}-component-${component.id}`
              return (
                <li key={component.id} className="flex items-center justify-between gap-stack-md">
                  <Label htmlFor={id} className="flex min-w-0 items-center gap-2">
                    <ComponentIcon
                      icon={component.icon}
                      iconUrl={component.iconUrl}
                      siteUrl={externalUrlOf(component)}
                    />
                    <span className="truncate">{componentName(component)}</span>
                    {component.enabled ? null : (
                      <Badge tone="neutral" appearance="filled">
                        {t('admin.roles.form.disabled')}
                      </Badge>
                    )}
                  </Label>
                  <Switch
                    id={id}
                    checked={selected.includes(component.id)}
                    onCheckedChange={(on) => onChange(withId(selected, component.id, on))}
                  />
                </li>
              )
            })}
          </ul>
        </>
      )}
    </FormSection>
  )
}

interface FeaturesSectionProps {
  idPrefix: string
  /** The catalogue, for the modules' names; their type's name stands in until it is there. */
  components: AdminComponent[] | undefined
  selected: RoleFormState['features']
  onChange: (features: RoleFormState['features']) => void
}

/** The module functions, a switch each with what it does, grouped under their module's name. */
function FeaturesSection({
  idPrefix,
  components,
  selected,
  onChange
}: FeaturesSectionProps): React.JSX.Element {
  const { t } = useTranslation()
  const componentName = useComponentName()
  const groups = useMemo(() => featuresByModule(), [])
  return (
    <FormSection
      title={t('admin.roles.form.features')}
      description={t('admin.roles.form.featuresDescription')}
    >
      {groups.map(({ module, features }) => {
        const headingId = `${idPrefix}-module-${module}`
        const component = components?.find((candidate) => candidate.type === module)
        return (
          <div
            key={module}
            role="group"
            aria-labelledby={headingId}
            className="flex flex-col gap-stack-sm"
          >
            {/* DS gap: no heading for a group of switches; `Label` gives it the label's look. */}
            <Label asChild>
              <h3 id={headingId} className="m-0">
                {component ? componentName(component) : t(`componentTypes.${module}`)}
              </h3>
            </Label>
            {features.map((feature) => (
              <FormItem key={feature} className="flex-row items-start justify-between gap-stack-md">
                <div className="flex flex-col gap-1">
                  <FormLabel>{t(`admin.roles.features.${feature}.label`)}</FormLabel>
                  <FormDescription>
                    {t(`admin.roles.features.${feature}.description`)}
                  </FormDescription>
                </div>
                <FormControl>
                  <Switch
                    checked={selected.includes(feature)}
                    onCheckedChange={(on) => onChange(withId(selected, feature, on))}
                  />
                </FormControl>
              </FormItem>
            ))}
          </div>
        )
      })}
    </FormSection>
  )
}
