import type { TFunction } from 'i18next'
import {
  ANNOUNCEMENT_BODY_MAX,
  ANNOUNCEMENT_PATH_MAX,
  ANNOUNCEMENT_SELECTOR_MAX,
  ANNOUNCEMENT_TITLE_MAX,
  announcementInputSchema,
  type AdminAnnouncement,
  type AnnouncementInput,
  type AnnouncementKind,
  type Language
} from '@justcampus/shared'
import { ApiRequestError } from './api'
import type { FieldErrors } from './component-form'

/** Title and text in one language, as typed. */
export interface AnnouncementTextDraft {
  title: string
  body: string
}

/**
 * The announcement editor's fields. The target fields stay filled while the kind is `news`, so
 * switching back to `hint` keeps them; only a hint sends them.
 */
export interface AnnouncementFormState {
  kind: AnnouncementKind
  enabled: boolean
  texts: Record<Language, AnnouncementTextDraft>
  selector: string
  /** Empty for every page. */
  path: string
}

export function initialAnnouncementForm(
  announcement: AdminAnnouncement | null
): AnnouncementFormState {
  if (!announcement) {
    return {
      kind: 'news',
      // New announcements reach nobody until the admin switches them on.
      enabled: false,
      texts: { de: { title: '', body: '' }, en: { title: '', body: '' } },
      selector: '',
      path: ''
    }
  }
  const { target } = announcement
  return {
    kind: announcement.kind,
    enabled: announcement.enabled,
    texts: {
      de: { ...announcement.texts.de },
      en: { ...announcement.texts.en }
    },
    selector: target?.selector ?? '',
    path: target?.path ?? ''
  }
}

/** Whether the form holds something `baseline` does not. A news' unused target fields count too. */
export function isAnnouncementFormDirty(
  state: AnnouncementFormState,
  baseline: AnnouncementFormState
): boolean {
  return JSON.stringify(state) !== JSON.stringify(baseline)
}

/**
 * Why `selector` cannot be used: `invalid` when it is not CSS (the browser's `querySelector`
 * throws), `null` when it is fine or still empty. `query` is the page's `querySelector`.
 */
export function selectorProblem(
  selector: string,
  query: (selector: string) => unknown
): 'invalid' | null {
  const trimmed = selector.trim()
  if (!trimmed) return null
  try {
    query(trimmed)
    return null
  } catch {
    return 'invalid'
  }
}

type Issue = { path: readonly PropertyKey[]; message: string }

/** Known fields get a translated message; anything else keeps the server's wording. */
function toFieldErrors(issues: readonly Issue[], t: TFunction): FieldErrors {
  const title = t('admin.announcements.form.errors.title', { max: ANNOUNCEMENT_TITLE_MAX })
  const body = t('admin.announcements.form.errors.body', { max: ANNOUNCEMENT_BODY_MAX })
  const messages: Partial<Record<string, string>> = {
    'texts.de.title': title,
    'texts.en.title': title,
    'texts.de.body': body,
    'texts.en.body': body,
    'target.selector': t('admin.announcements.form.errors.selector', {
      max: ANNOUNCEMENT_SELECTOR_MAX
    }),
    'target.path': t('admin.announcements.form.errors.path', { max: ANNOUNCEMENT_PATH_MAX })
  }
  const errors: FieldErrors = {}
  for (const issue of issues) {
    const key = issue.path.map(String).join('.') || 'form'
    errors[key] ??= messages[key] ?? issue.message
  }
  return errors
}

export type AnnouncementValidation =
  { ok: true; input: AnnouncementInput } | { ok: false; errors: FieldErrors }

/** The form as the API's input, or the errors keyed by field (`texts.de.title`, `target.path`). */
export function validateAnnouncementForm(
  state: AnnouncementFormState,
  t: TFunction,
  query: (selector: string) => unknown
): AnnouncementValidation {
  const path = state.path.trim()
  const result = announcementInputSchema.safeParse({
    kind: state.kind,
    enabled: state.enabled,
    texts: state.texts,
    target: state.kind === 'hint' ? { selector: state.selector, path: path ? path : null } : null
  })
  const errors = result.success ? {} : toFieldErrors(result.error.issues, t)
  if (state.kind === 'hint' && selectorProblem(state.selector, query)) {
    errors['target.selector'] ??= t('admin.announcements.form.errors.selectorInvalid')
  }
  if (result.success && Object.keys(errors).length === 0) return { ok: true, input: result.data }
  return { ok: false, errors }
}

/** Server-side validation errors, mapped onto the form's fields. */
export function serverAnnouncementErrors(error: unknown, t: TFunction): FieldErrors | null {
  if (!(error instanceof ApiRequestError) || error.code !== 'validation') return null
  const issues = error.body?.error.issues ?? []
  return issues.length > 0 ? toFieldErrors(issues, t) : null
}
