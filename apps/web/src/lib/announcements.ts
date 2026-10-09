import { z } from 'zod'
import {
  ANNOUNCEMENT_KINDS,
  ANNOUNCEMENT_SIDES,
  announcementPathMatches,
  type Language,
  type UserAnnouncement
} from '@justcampus/shared'
import type { AnnouncementFormState, AnnouncementTextDraft } from './announcement-form'

export type UserNews = Extract<UserAnnouncement, { kind: 'news' }>
export type UserHint = Extract<UserAnnouncement, { kind: 'hint' }>

/** Title and text in the UI language. */
export function textIn(
  texts: Record<Language, AnnouncementTextDraft>,
  language: Language
): AnnouncementTextDraft {
  return texts[language]
}

/**
 * The body's paragraphs, each as its lines: blank lines separate paragraphs, single line breaks
 * stay line breaks.
 */
export function paragraphsOf(body: string): string[][] {
  return body
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(/\n[^\S\n]*\n\s*/)
    .map((paragraph) => paragraph.split('\n').map((line) => line.trim()))
    .filter((lines) => lines.some(Boolean))
}

const byPublishedAt = (a: UserAnnouncement, b: UserAnnouncement): number =>
  Date.parse(a.publishedAt) - Date.parse(b.publishedAt)

/** Every news item, newest first: what "What's new" pages through. */
export function allNews(announcements: readonly UserAnnouncement[]): UserNews[] {
  return announcements
    .filter((item): item is UserNews => item.kind === 'news')
    .sort((a, b) => byPublishedAt(b, a))
}

/** The news the user has not acknowledged, newest first: what opens by itself. */
export function unreadNews(announcements: readonly UserAnnouncement[]): UserNews[] {
  return allNews(announcements).filter((item) => !item.seen)
}

/**
 * The hints that may show on `pathname`, in the order they take turns: not yet acknowledged,
 * limited to a matching path, oldest first. Which one shows depends on whose element is on screen.
 */
export function hintQueue(
  announcements: readonly UserAnnouncement[],
  pathname: string
): UserHint[] {
  return announcements
    .filter((item): item is UserHint => item.kind === 'hint' && !item.seen)
    .filter((item) => announcementPathMatches(item.target.path, pathname))
    .sort(byPublishedAt)
}

/**
 * Where "Test on page" goes for a page path: the path itself, the part before a trailing `*`, or
 * the dashboard when the hint is meant for every page.
 */
export function previewPathFor(path: string): string {
  const trimmed = path.trim()
  if (!trimmed) return '/'
  const prefix = trimmed.endsWith('*') ? trimmed.slice(0, -1) : trimmed
  return prefix.startsWith('/') ? prefix : '/'
}

/**
 * A hint tried out from its editor before it is saved. While `active` it shows on every page whose
 * element it finds; afterwards it waits, inactive, for its editor to take the form back.
 */
export interface AnnouncementPreview {
  active: boolean
  /** The announcement being edited; `null` for a new one. */
  announcementId: string | null
  form: AnnouncementFormState
}

const textDraftSchema = z.object({ title: z.string(), body: z.string() })

const previewSchema = z.object({
  active: z.boolean(),
  announcementId: z.string().nullable(),
  form: z.object({
    kind: z.enum(ANNOUNCEMENT_KINDS),
    enabled: z.boolean(),
    texts: z.object({ de: textDraftSchema, en: textDraftSchema }),
    selector: z.string(),
    path: z.string(),
    side: z.enum(ANNOUNCEMENT_SIDES)
  })
})

export function serializePreview(preview: AnnouncementPreview): string {
  return JSON.stringify(preview)
}

/** The stored preview, or `null` when there is none or it is not one (an older build's). */
export function parsePreview(raw: string | null): AnnouncementPreview | null {
  if (!raw) return null
  try {
    const parsed = previewSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** Whether the stored preview belongs to the editor of `announcementId` (`null`: a new one). */
export function isPreviewFor(
  preview: AnnouncementPreview | null,
  announcementId: string | null
): preview is AnnouncementPreview {
  return preview !== null && preview.announcementId === announcementId
}
