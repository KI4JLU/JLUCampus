import {
  ANNOUNCEMENTS_API,
  adminAnnouncementSchema,
  announcementInputSchema,
  userAnnouncementListSchema,
  type AdminAnnouncement
} from '@justcampus/shared'
import { and, desc, eq, getTableColumns, sql } from 'drizzle-orm'
import type { Hono } from 'hono'
import { z } from 'zod'

import { ApiError, parseBody, validationIssues } from './api.js'
import { db } from './db/index.js'
import { announcement, announcementSeen } from './db/schema.js'
import type { AppEnvironment } from './modules/index.js'

type AnnouncementRow = typeof announcement.$inferSelect
type SessionUser = AppEnvironment['Variables']['session']['user']

export function visibleTo<T extends AnnouncementRow>(_user: SessionUser, announcements: T[]): T[] {
  // Audience rules plug in here; currently every signed-in user receives every announcement.
  return announcements
}

function parseId(value: string | undefined): string {
  const result = z.uuid().safeParse(value)
  if (!result.success) {
    throw new ApiError(400, 'validation', 'Invalid announcement id', validationIssues(result.error))
  }
  return result.data
}

const adminColumns = {
  ...getTableColumns(announcement),
  seenCount: sql<number>`(select count(*)::int from ${announcementSeen}
    where ${announcementSeen.announcementId} = ${announcement.id})`
}

function toAdmin(row: AnnouncementRow & { seenCount: number }): AdminAnnouncement {
  return adminAnnouncementSchema.parse({
    ...row,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  })
}

async function readAdmin(id: string): Promise<AdminAnnouncement> {
  const [row] = await db.select(adminColumns).from(announcement).where(eq(announcement.id, id))
  if (!row) throw new ApiError(404, 'not_found', 'Announcement not found')
  return toAdmin(row)
}

export function registerAnnouncementRoutes(app: Hono<AppEnvironment>): void {
  app.get(ANNOUNCEMENTS_API.admin, async (context) => {
    const rows = await db
      .select(adminColumns)
      .from(announcement)
      .orderBy(desc(announcement.createdAt))
    return context.json({ announcements: rows.map(toAdmin) })
  })

  app.post(ANNOUNCEMENTS_API.admin, async (context) => {
    const input = await parseBody(context, announcementInputSchema)
    const [created] = await db
      .insert(announcement)
      .values({ ...input, publishedAt: input.enabled ? new Date() : null })
      .returning()
    return context.json(toAdmin({ ...created!, seenCount: 0 }), 201)
  })

  app.get(ANNOUNCEMENTS_API.adminOne(':id'), async (context) => {
    return context.json(await readAdmin(parseId(context.req.param('id'))))
  })

  app.put(ANNOUNCEMENTS_API.adminOne(':id'), async (context) => {
    const id = parseId(context.req.param('id'))
    const input = await parseBody(context, announcementInputSchema)
    const [updated] = await db
      .update(announcement)
      .set({
        ...input,
        publishedAt: input.enabled
          ? sql`coalesce(${announcement.publishedAt}, now())`
          : announcement.publishedAt,
        updatedAt: new Date()
      })
      .where(eq(announcement.id, id))
      .returning()
    if (!updated) throw new ApiError(404, 'not_found', 'Announcement not found')
    return context.json(await readAdmin(id))
  })

  app.delete(ANNOUNCEMENTS_API.adminOne(':id'), async (context) => {
    const id = parseId(context.req.param('id'))
    const [deleted] = await db.delete(announcement).where(eq(announcement.id, id)).returning()
    if (!deleted) throw new ApiError(404, 'not_found', 'Announcement not found')
    return context.body(null, 204)
  })

  app.post(ANNOUNCEMENTS_API.adminReset(':id'), async (context) => {
    const id = parseId(context.req.param('id'))
    const record = await db.transaction(async (transaction) => {
      const [row] = await transaction
        .select()
        .from(announcement)
        .where(eq(announcement.id, id))
        .for('update')
      if (!row) throw new ApiError(404, 'not_found', 'Announcement not found')
      await transaction.delete(announcementSeen).where(eq(announcementSeen.announcementId, id))
      return row
    })
    return context.json(toAdmin({ ...record, seenCount: 0 }))
  })

  app.get(ANNOUNCEMENTS_API.announcements, async (context) => {
    const user = context.get('session').user
    const rows = await db
      .select({
        ...getTableColumns(announcement),
        seen: sql<boolean>`exists (select 1 from ${announcementSeen}
          where ${announcementSeen.announcementId} = ${announcement.id}
          and ${announcementSeen.userId} = ${user.id})`
      })
      .from(announcement)
      .where(eq(announcement.enabled, true))
      .orderBy(desc(announcement.publishedAt))
    return context.json(
      userAnnouncementListSchema.parse({
        announcements: visibleTo(user, rows).map((row) => ({
          ...row,
          publishedAt: row.publishedAt?.toISOString()
        }))
      })
    )
  })

  app.post(ANNOUNCEMENTS_API.seen(':id'), async (context) => {
    const id = parseId(context.req.param('id'))
    const user = context.get('session').user
    await db.transaction(async (transaction) => {
      const rows = await transaction
        .select()
        .from(announcement)
        .where(and(eq(announcement.id, id), eq(announcement.enabled, true)))
        .for('share')
      if (visibleTo(user, rows).length === 0) {
        throw new ApiError(404, 'not_found', 'Announcement not found')
      }
      await transaction
        .insert(announcementSeen)
        .values({ announcementId: id, userId: user.id })
        .onConflictDoNothing()
    })
    return context.body(null, 204)
  })
}
