/**
 * Announcements: messages admins publish to users, written in every UI language.
 *
 * - `news` (feature updates and the like) open once as a dialog the next time a user opens the
 *   app; several unread ones are paged. Users can read them again later from the account menu.
 * - `hint` belongs to one element of the app, found by a CSS selector, optionally only on pages
 *   matching `path`. When the user clicks that element (or anything in it), the hint opens as a
 *   dialog like a news item, one at a time; once acknowledged it does not open again.
 *
 * A user sees an announcement until they acknowledge it (`ANNOUNCEMENTS_API.seen`), stored per
 * user on the server, so it does not come back on another device. Who receives an announcement is
 * decided on the server (`visibleTo` in `apps/server/src/announcements.ts`); today that is every
 * signed-in user.
 */
import { z } from 'zod'

export const ANNOUNCEMENT_KINDS = ['news', 'hint'] as const
export const announcementKindSchema = z.enum(ANNOUNCEMENT_KINDS)
export type AnnouncementKind = z.infer<typeof announcementKindSchema>

export const ANNOUNCEMENT_TITLE_MAX = 120
export const ANNOUNCEMENT_BODY_MAX = 4000
export const ANNOUNCEMENT_SELECTOR_MAX = 500
export const ANNOUNCEMENT_PATH_MAX = 300

/** Title and text in one language. The body is plain text; blank lines separate paragraphs. */
export const announcementTextSchema = z.object({
  title: z.string().trim().min(1).max(ANNOUNCEMENT_TITLE_MAX),
  body: z.string().trim().min(1).max(ANNOUNCEMENT_BODY_MAX)
})
export type AnnouncementText = z.infer<typeof announcementTextSchema>

/** Both UI languages are required; users see the one their app is set to. */
export const announcementTextsSchema = z.object({
  de: announcementTextSchema,
  en: announcementTextSchema
})
export type AnnouncementTexts = z.infer<typeof announcementTextsSchema>

/**
 * A page path the hint is limited to: starts with `/`; a trailing `*` matches every path with
 * that prefix (`/c/*`). `null` means every page.
 */
export const announcementPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(ANNOUNCEMENT_PATH_MAX)
  .regex(/^\/[^*\s]*\*?$/, { message: 'Path must start with / and may end with a single *' })

/**
 * The element whose click opens a `hint`, and the pages it does so on. The server cannot check the
 * selector; the admin page does. Targets stored before hints opened as dialogs carry a `side`;
 * parsing drops it like any unknown key.
 */
export const announcementTargetSchema = z.object({
  selector: z.string().trim().min(1).max(ANNOUNCEMENT_SELECTOR_MAX),
  path: announcementPathSchema.nullable()
})
export type AnnouncementTarget = z.infer<typeof announcementTargetSchema>

const newsFields = { kind: z.literal('news'), target: z.null() }
const hintFields = { kind: z.literal('hint'), target: announcementTargetSchema }

const announcementBaseInputSchema = z.object({
  texts: announcementTextsSchema,
  /** Disabled announcements stay in the admin list but reach nobody. */
  enabled: z.boolean()
})

export const announcementInputSchema = z.discriminatedUnion('kind', [
  announcementBaseInputSchema.extend(newsFields),
  announcementBaseInputSchema.extend(hintFields)
])
export type AnnouncementInput = z.infer<typeof announcementInputSchema>

const adminAnnouncementBaseSchema = announcementBaseInputSchema.extend({
  id: z.string().uuid(),
  /** When the announcement was first enabled; `null` while it never was. News are dated by it. */
  publishedAt: z.string().datetime().nullable(),
  /** How many users have acknowledged it. */
  seenCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
})

/** An announcement as the admin API returns it. */
export const adminAnnouncementSchema = z.discriminatedUnion('kind', [
  adminAnnouncementBaseSchema.extend(newsFields),
  adminAnnouncementBaseSchema.extend(hintFields)
])
export type AdminAnnouncement = z.infer<typeof adminAnnouncementSchema>

export const adminAnnouncementListSchema = z.object({
  announcements: z.array(adminAnnouncementSchema)
})
export type AdminAnnouncementList = z.infer<typeof adminAnnouncementListSchema>

const userAnnouncementBaseSchema = z.object({
  id: z.string().uuid(),
  texts: announcementTextsSchema,
  publishedAt: z.string().datetime(),
  /** Whether the user acknowledged it already. */
  seen: z.boolean()
})

/** An announcement as the current user receives it, with both languages so a language switch needs no refetch. */
export const userAnnouncementSchema = z.discriminatedUnion('kind', [
  userAnnouncementBaseSchema.extend(newsFields),
  userAnnouncementBaseSchema.extend(hintFields)
])
export type UserAnnouncement = z.infer<typeof userAnnouncementSchema>

export const userAnnouncementListSchema = z.object({
  /** Enabled announcements meant for the user, newest first. */
  announcements: z.array(userAnnouncementSchema)
})
export type UserAnnouncementList = z.infer<typeof userAnnouncementListSchema>

/** Whether a hint limited to `path` shows on `pathname` (see `announcementPathSchema`). */
export function announcementPathMatches(path: string | null, pathname: string): boolean {
  if (path === null) return true
  if (path.endsWith('*')) return pathname.startsWith(path.slice(0, -1))
  return pathname === path || pathname === `${path}/`
}

export const ANNOUNCEMENTS_API = {
  /** GET: `userAnnouncementListSchema`. Any signed-in user. */
  announcements: '/api/announcements',
  /**
   * POST → 204: the current user acknowledged the announcement. Idempotent. An id the user cannot
   * see (unknown, disabled or not meant for them) answers `404 not_found`.
   */
  seen: (id: string) => `/api/announcements/${id}/seen`,
  /** Admin only. GET: `adminAnnouncementListSchema`, newest first. POST: `announcementInputSchema` → 201 with `adminAnnouncementSchema`. */
  admin: '/api/admin/announcements',
  /** Admin only. GET / PUT (`announcementInputSchema`) → `adminAnnouncementSchema`; DELETE → 204. */
  adminOne: (id: string) => `/api/admin/announcements/${id}`,
  /** Admin only. POST → `adminAnnouncementSchema`: forgets every acknowledgement, so all users see it again. */
  adminReset: (id: string) => `/api/admin/announcements/${id}/reset`
} as const
