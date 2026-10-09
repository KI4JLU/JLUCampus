import { z } from 'zod'
import {
  ANNOUNCEMENT_KINDS,
  ANNOUNCEMENT_SIDES,
  announcementPathMatches,
  type Language,
  type Me,
  type UserAnnouncement
} from '@justcampus/shared'
import type { AnnouncementFormState, AnnouncementTextDraft } from './announcement-form'
import { ApiRequestError } from './api'

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
 * element it finds; afterwards it waits, inactive, for its editor to take the form back. Only the
 * admin who started it sees it (see `previewOwnedBy`).
 */
export interface AnnouncementPreview {
  active: boolean
  /** The admin who started it. */
  ownerId: string
  /** The announcement being edited; `null` for a new one. */
  announcementId: string | null
  form: AnnouncementFormState
}

const textDraftSchema = z.object({ title: z.string(), body: z.string() })

const previewSchema = z.object({
  active: z.boolean(),
  ownerId: z.string().min(1),
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

/**
 * Whether `user` may see the stored preview: the admin who started it, still an admin. The tab's
 * storage outlives a session, so anyone else signing in there must not see the unsaved text.
 */
export function previewOwnedBy(
  preview: AnnouncementPreview | null,
  user: Pick<Me, 'id' | 'role'> | null | undefined
): preview is AnnouncementPreview {
  return preview !== null && user?.role === 'admin' && preview.ownerId === user.id
}

/**
 * Whether the stored preview belongs to `user`'s editor of `announcementId` (`null`: a new
 * announcement).
 */
export function isPreviewFor(
  preview: AnnouncementPreview | null,
  announcementId: string | null,
  user: Pick<Me, 'id' | 'role'> | null | undefined
): preview is AnnouncementPreview {
  return previewOwnedBy(preview, user) && preview.announcementId === announcementId
}

/** How often acknowledging is tried again after the first attempt. */
export const SEEN_RETRIES = 3

/**
 * Thrown instead of sending an acknowledgement when the user who closed the announcement is no
 * longer the one signed in, so a retry never acknowledges it for the next person on the device.
 */
export class SeenByOtherUserError extends Error {
  constructor() {
    super('The signed-in user changed before the acknowledgement was sent')
    this.name = 'SeenByOtherUserError'
  }
}

/**
 * Whether a failed acknowledgement is tried again: on network errors and server failures, not when
 * the server refused it (an announcement gone or not meant for the user, a session that ended) or
 * the signed-in user changed.
 */
export function retrySeen(failureCount: number, error: Error): boolean {
  if (error instanceof SeenByOtherUserError) return false
  if (error instanceof ApiRequestError && error.status < 500) return false
  return failureCount < SEEN_RETRIES
}

/** Waits 1, 2, 4 … seconds between attempts, at most 10. */
export function seenRetryDelay(failureCount: number): number {
  return Math.min(1000 * 2 ** failureCount, 10_000)
}
