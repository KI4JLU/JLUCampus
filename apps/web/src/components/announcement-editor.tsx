import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { flushSync } from 'react-dom'
import { Link, useBlocker, useNavigate, useRouter } from '@tanstack/react-router'
import { useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { ArrowLeftIcon, PlayIcon, Trash2Icon } from 'lucide-react'
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
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea
} from '@ki4jlu/design-system'
import {
  ANNOUNCEMENT_BODY_MAX,
  ANNOUNCEMENT_KINDS,
  ANNOUNCEMENT_PATH_MAX,
  ANNOUNCEMENT_SELECTOR_MAX,
  ANNOUNCEMENT_TITLE_MAX,
  LANGUAGES,
  announcementKindSchema,
  type AdminAnnouncement,
  type Language
} from '@justcampus/shared'
import { currentLanguage } from '@/i18n'
import {
  initialAnnouncementForm,
  isAnnouncementFormDirty,
  selectorProblem,
  serverAnnouncementErrors,
  validateAnnouncementForm,
  type AnnouncementFormState,
  type AnnouncementTextDraft
} from '@/lib/announcement-form'
import {
  clearAnnouncementPreview,
  readAnnouncementPreview,
  startAnnouncementPreview
} from '@/lib/announcement-preview'
import { isPreviewFor, previewPathFor, textIn } from '@/lib/announcements'
import type { FieldErrors } from '@/lib/component-form'
import {
  componentsQuery,
  meQuery,
  queryKeys,
  useCreateAnnouncement,
  useUpdateAnnouncement
} from '@/lib/queries'
import { toast } from '@/lib/toast'
import { componentTourId, tourSelector, TOUR_TARGETS } from '@/lib/tour-targets'
import { AnnouncementAutoTranslate } from './announcement-auto-translate'
import { DeleteAnnouncementDialog, type AnnouncementTarget } from './announcement-dialogs'
import { Field } from './field'
import { FormSection } from './form-section'
import { PageHeader } from './page-header'
import { Alert, AlertDescription } from './ui/alert'

const ICON = { 'aria-hidden': true, width: '1em', height: '1em' } as const

/** The language admins write first; the others can be translated from it. */
const SOURCE_LANGUAGE: Language = 'de'

/** Every navigation away is a candidate; `disabled` lets them through while nothing is unsaved. */
const BLOCK_NAVIGATION = (): boolean => true

const querySelector = (selector: string): unknown => document.querySelector(selector)

interface AnnouncementEditorProps {
  /** The announcement as saved; `null` creates a new one. */
  announcement: AdminAnnouncement | null
}

/**
 * The admin's page for one announcement: its kind and state, its text in each UI language and,
 * for a hint, the element it points at, one card each, under a save bar that stays in view. A
 * hint can be tried out on its page before it is saved; the unsaved form waits in the tab and
 * comes back here. Leaving the page with unsaved changes asks first.
 */
export function AnnouncementEditor({ announcement }: AnnouncementEditorProps): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const router = useRouter()
  const client = useQueryClient()
  const formId = useId()
  const formRef = useRef<HTMLFormElement>(null)
  const announcementId = announcement?.id ?? null
  const { data: me } = useSuspenseQuery(meQuery)
  // The values as loaded or last saved; the form has unsaved changes while it differs from them.
  const [baseline, setBaseline] = useState(() => initialAnnouncementForm(announcement))
  // The form a preview of this announcement took along, if the admin comes back from one.
  const [restored] = useState(() => {
    const preview = readAnnouncementPreview()
    return isPreviewFor(preview, announcementId, me) ? preview.form : null
  })
  const [state, setState] = useState<AnnouncementFormState>(restored ?? baseline)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [failed, setFailed] = useState(false)
  const [deleting, setDeleting] = useState<AnnouncementTarget | null>(null)
  const create = useCreateAnnouncement()
  const update = useUpdateAnnouncement()
  const pending = create.isPending || update.isPending
  const dirty = isAnnouncementFormDirty(state, baseline)
  const blocker = useBlocker({
    shouldBlockFn: BLOCK_NAVIGATION,
    disabled: !dirty,
    withResolver: true
  })
  const savedTitle = announcement ? textIn(announcement.texts, currentLanguage()).title : ''

  // The form is back in the editor, so the preview is over.
  useEffect(() => {
    if (restored) clearAnnouncementPreview()
  }, [restored])

  const set = <K extends keyof AnnouncementFormState>(
    key: K,
    value: AnnouncementFormState[K]
  ): void => setState((current) => ({ ...current, [key]: value }))

  const setText = (language: Language, text: Partial<AnnouncementTextDraft>): void =>
    setState((current) => ({
      ...current,
      texts: { ...current.texts, [language]: { ...current.texts[language], ...text } }
    }))

  /** On a long page the first error may be out of view: the admin is taken to it. */
  const showErrors = (next: FieldErrors): void => {
    flushSync(() => setErrors(next))
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    setFailed(false)
    const result = validateAnnouncementForm(state, t, querySelector)
    if (!result.ok) {
      showErrors(result.errors)
      return
    }
    setErrors({})
    // Edits made while the save runs stay, as unsaved changes on top of the saved values.
    const submitted = state
    const onError = (error: Error): void => {
      const fieldErrors = serverAnnouncementErrors(error, t)
      if (fieldErrors) showErrors(fieldErrors)
      else setFailed(true)
    }
    if (announcement) {
      update.mutate(
        { id: announcement.id, input: result.input },
        {
          onSuccess: (saved) => {
            client.setQueryData(queryKeys.adminAnnouncement(saved.id), saved)
            const next = initialAnnouncementForm(saved)
            setBaseline(next)
            setState((current) => (current === submitted ? next : current))
            toast({ variant: 'success', title: t('admin.announcements.form.updated') })
          },
          onError
        }
      )
    } else {
      create.mutate(result.input, {
        onSuccess: (created) => {
          toast({ variant: 'success', title: t('admin.announcements.form.created') })
          // Saved: the new announcement's own page takes over, as in the component editor.
          void navigate({
            to: '/admin/announcements/$announcementId',
            params: { announcementId: created.id },
            replace: true,
            ignoreBlocker: true
          })
        },
        onError
      })
    }
  }

  /** Takes the unsaved hint to its page, shown only to the admin, saving nothing. */
  const testOnPage = (): void => {
    if (!state.selector.trim()) {
      showErrors({ 'target.selector': t('admin.announcements.form.errors.selectorRequired') })
      return
    }
    if (selectorProblem(state.selector, querySelector)) {
      showErrors({ 'target.selector': t('admin.announcements.form.errors.selectorInvalid') })
      return
    }
    startAnnouncementPreview({ ownerId: me.id, announcementId, form: state })
    // A path prefix that is no page of its own (`/c/` of `/c/*`) starts on the dashboard instead.
    const path = previewPathFor(state.path)
    const isPage = router.getMatchedRoutes(path)[2] !== undefined
    void navigate({ href: isPage ? path : '/', ignoreBlocker: true })
  }

  return (
    <Container className="flex flex-col gap-gutter py-gutter md:py-margin-page">
      <PageHeader
        title={
          announcement
            ? t('admin.announcements.form.editTitle', { title: savedTitle })
            : t('admin.announcements.form.createTitle')
        }
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to="/admin/announcements">
                <ArrowLeftIcon {...ICON} />
                {t('admin.announcements.form.back')}
              </Link>
            </Button>
            {announcement ? (
              <Button
                variant="ghost-destructive"
                onClick={() => setDeleting({ id: announcement.id, title: savedTitle })}
              >
                <Trash2Icon {...ICON} />
                {t('common.delete')}
              </Button>
            ) : null}
          </>
        }
      />
      {restored && dirty ? (
        <Alert variant="info">
          <AlertDescription>{t('admin.announcements.form.restored')}</AlertDescription>
        </Alert>
      ) : null}
      <form ref={formRef} noValidate onSubmit={handleSubmit} className="flex flex-col gap-gutter">
        <FormSection
          title={t('admin.announcements.form.general')}
          description={t('admin.announcements.form.generalDescription')}
        >
          <Field
            id={`${formId}-kind`}
            label={t('admin.announcements.form.kind')}
            hint={t(`admin.announcements.form.kindHints.${state.kind}`)}
          >
            {(control) => (
              <Select
                value={state.kind}
                onValueChange={(value) => set('kind', announcementKindSchema.parse(value))}
              >
                <SelectTrigger {...control}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ANNOUNCEMENT_KINDS.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {t(`admin.announcements.kinds.${kind}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
          <div className="flex items-center justify-between gap-stack-md">
            <div className="grid gap-1">
              <Label htmlFor={`${formId}-enabled`}>{t('admin.announcements.form.enabled')}</Label>
              <p id={`${formId}-enabled-hint`} className="text-sm text-on-surface-variant">
                {t('admin.announcements.form.enabledHint')}
              </p>
            </div>
            <Switch
              id={`${formId}-enabled`}
              aria-describedby={`${formId}-enabled-hint`}
              checked={state.enabled}
              onCheckedChange={(checked) => set('enabled', checked)}
            />
          </div>
        </FormSection>
        {LANGUAGES.map((language) => (
          <FormSection key={language} title={t(`language.${language}`)}>
            {language !== SOURCE_LANGUAGE ? (
              <AnnouncementAutoTranslate
                from={SOURCE_LANGUAGE}
                to={language}
                source={state.texts[SOURCE_LANGUAGE]}
                current={state.texts[language]}
                onTranslated={(text) => setText(language, text)}
              />
            ) : null}
            <Field
              id={`${formId}-${language}-title`}
              label={t('admin.announcements.form.title')}
              error={errors[`texts.${language}.title`]}
            >
              {(control) => (
                <Input
                  {...control}
                  lang={language}
                  value={state.texts[language].title}
                  maxLength={ANNOUNCEMENT_TITLE_MAX}
                  required
                  onChange={(event) => setText(language, { title: event.target.value })}
                />
              )}
            </Field>
            <Field
              id={`${formId}-${language}-body`}
              label={t('admin.announcements.form.body')}
              hint={t('admin.announcements.form.bodyHint')}
              error={errors[`texts.${language}.body`]}
            >
              {(control) => (
                <Textarea
                  {...control}
                  lang={language}
                  rows={6}
                  value={state.texts[language].body}
                  maxLength={ANNOUNCEMENT_BODY_MAX}
                  required
                  onChange={(event) => setText(language, { body: event.target.value })}
                />
              )}
            </Field>
          </FormSection>
        ))}
        {state.kind === 'hint' ? (
          <TargetSection
            formId={formId}
            state={state}
            errors={errors}
            onChange={(patch) => setState((current) => ({ ...current, ...patch }))}
            onTest={testOnPage}
          />
        ) : null}
        {/* DS gap: no sticky action bar for long forms; a Card held at the foot of the view stands in. */}
        <Card className="sticky bottom-stack-md z-10">
          <div className="flex flex-col gap-stack-sm p-stack-md">
            {failed || errors.form ? (
              <Alert variant="destructive">
                <AlertDescription>
                  {errors.form ?? t('admin.announcements.form.saveFailed')}
                </AlertDescription>
              </Alert>
            ) : null}
            <div className="flex flex-wrap items-center justify-end gap-stack-sm">
              <Button variant="secondary" asChild>
                <Link to="/admin/announcements">{t('common.cancel')}</Link>
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? t('common.saving') : t('common.save')}
              </Button>
            </div>
          </div>
        </Card>
      </form>
      <DeleteAnnouncementDialog
        target={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={() => void navigate({ to: '/admin/announcements', ignoreBlocker: true })}
      />
      <Dialog
        open={blocker.status === 'blocked'}
        onOpenChange={(open) => (open ? undefined : blocker.reset?.())}
      >
        <DialogContent closeLabel={t('common.close')}>
          <DialogHeader>
            <DialogTitle>{t('admin.form.unsaved.title')}</DialogTitle>
            <DialogDescription>
              {t('admin.announcements.form.unsavedDescription')}
            </DialogDescription>
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

interface TargetSectionProps {
  formId: string
  state: AnnouncementFormState
  errors: FieldErrors
  onChange: (patch: Partial<AnnouncementFormState>) => void
  onTest: () => void
}

/**
 * Which click opens a hint: the element (picked from the app's marked elements or as any CSS
 * selector, checked as it is typed) and the pages it does so on.
 */
function TargetSection({
  formId,
  state,
  errors,
  onChange,
  onTest
}: TargetSectionProps): React.JSX.Element {
  const { t } = useTranslation()
  const { data: components } = useQuery(componentsQuery)
  const suggestions = useMemo(
    () => [
      ...TOUR_TARGETS.map((target) => ({
        group: 'shell' as const,
        selector: target.selector,
        label: t(`announcements.tourTargets.${target.label}`),
        path: target.path
      })),
      ...(components ?? []).map((component) => ({
        group: 'sidebar' as const,
        selector: tourSelector(componentTourId(component.id)),
        label: component.name,
        path: undefined
      }))
    ],
    [components, t]
  )
  const selector = state.selector.trim()
  const picked = suggestions.find((suggestion) => suggestion.selector === selector)
  const invalid = selectorProblem(selector, querySelector) === 'invalid'
  const selectorError =
    errors['target.selector'] ??
    (invalid ? t('admin.announcements.form.errors.selectorInvalid') : undefined)

  const pick = (value: string): void => {
    const suggestion = suggestions.find((item) => item.selector === value)
    if (!suggestion) return
    // An element only one page has takes that page along, unless the admin chose pages already.
    const path = suggestion.path && !state.path.trim() ? suggestion.path : state.path
    onChange({ selector: suggestion.selector, path })
  }

  return (
    <FormSection
      title={t('admin.announcements.form.target')}
      description={t('admin.announcements.form.targetDescription')}
    >
      <div className="grid items-start gap-stack-md md:grid-cols-2">
        <Field
          id={`${formId}-suggestion`}
          label={t('admin.announcements.form.suggestion')}
          hint={t('admin.announcements.form.suggestionHint')}
        >
          {(control) => (
            <Select value={picked?.selector ?? ''} onValueChange={pick}>
              <SelectTrigger {...control}>
                <SelectValue placeholder={t('admin.announcements.form.suggestionPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>{t('admin.announcements.form.suggestionShell')}</SelectLabel>
                  {suggestions
                    .filter((item) => item.group === 'shell')
                    .map((item) => (
                      <SelectItem key={item.selector} value={item.selector}>
                        {item.label}
                      </SelectItem>
                    ))}
                </SelectGroup>
                {components && components.length > 0 ? (
                  <SelectGroup>
                    <SelectLabel>{t('admin.announcements.form.suggestionSidebar')}</SelectLabel>
                    {suggestions
                      .filter((item) => item.group === 'sidebar')
                      .map((item) => (
                        <SelectItem key={item.selector} value={item.selector}>
                          {item.label}
                        </SelectItem>
                      ))}
                  </SelectGroup>
                ) : null}
              </SelectContent>
            </Select>
          )}
        </Field>
        <Field
          id={`${formId}-selector`}
          label={t('admin.announcements.form.selector')}
          hint={t('admin.announcements.form.selectorHint')}
          error={selectorError}
        >
          {(control) => (
            <Input
              {...control}
              value={state.selector}
              maxLength={ANNOUNCEMENT_SELECTOR_MAX}
              required
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              onChange={(event) => onChange({ selector: event.target.value })}
            />
          )}
        </Field>
        <Field
          id={`${formId}-path`}
          label={t('admin.announcements.form.path')}
          hint={t('admin.announcements.form.pathHint')}
          error={errors['target.path']}
        >
          {(control) => (
            <Input
              {...control}
              value={state.path}
              maxLength={ANNOUNCEMENT_PATH_MAX}
              placeholder="/c/*"
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              onChange={(event) => onChange({ path: event.target.value })}
            />
          )}
        </Field>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-stack-sm">
        <Button type="button" variant="outline" onClick={onTest}>
          <PlayIcon {...ICON} />
          {t('admin.announcements.form.test')}
        </Button>
      </div>
    </FormSection>
  )
}
