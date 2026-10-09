import { COMPONENT_WIDGETS, type ComponentType } from '@justcampus/shared'
import { eq, sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'

import { ensureBuiltInRoles, grantEveryoneComponent } from '../access.js'
import { client, db } from './index.js'
import { component, folderTemplate, folderTemplateItem, layoutPreset } from './schema.js'

try {
  await ensureBuiltInRoles()
  const result = await db.select({ count: sql<number>`count(*)::int` }).from(component)
  const count = result[0]?.count ?? 0

  if (count === 0) {
    const inserted = await db
      .insert(component)
      .values([
        {
          name: 'JLU website',
          type: 'iframe',
          icon: 'graduation-cap',
          iconUrl: null,
          config: { url: 'https://www.uni-giessen.de' },
          enabled: true,
          sortOrder: 0
        },
        {
          name: 'Stud.IP',
          type: 'iframe',
          icon: 'book-open',
          iconUrl: null,
          config: { url: 'https://studip.uni-giessen.de' },
          enabled: true,
          sortOrder: 1
        }
      ])
      .returning({ id: component.id })
    for (const { id } of inserted) await grantEveryoneComponent(id)
    console.log('Inserted example components')
  } else {
    console.log('Component catalogue is not empty; skipped seed')
  }

  const templateResult = await db.select({ count: sql<number>`count(*)::int` }).from(folderTemplate)
  const templateCount = templateResult[0]?.count ?? 0
  const components = await db
    .select({ id: component.id, type: component.type })
    .from(component)
    .orderBy(component.sortOrder)
    .limit(2)
  if (templateCount === 0 && components.length > 0) {
    const [template] = await db
      .insert(folderTemplate)
      .values({ name: 'Studium', icon: 'graduation-cap', enabled: true, sortOrder: 0 })
      .returning({ id: folderTemplate.id })
    if (template) {
      await db.insert(folderTemplateItem).values(
        components.map(({ id }, position) => ({
          templateId: template.id,
          componentId: id,
          widgetKey: 'launcher',
          position
        }))
      )
    }
    console.log('Inserted example folder template')
  } else {
    console.log('Folder templates exist or component catalogue is empty; skipped seed')
  }

  const [everyonePreset] = await db
    .select({ id: layoutPreset.id })
    .from(layoutPreset)
    .where(eq(layoutPreset.audienceKind, 'everyone'))
    .limit(1)
  if (!everyonePreset && components.length > 0) {
    await db.insert(layoutPreset).values({
      name: 'Standard',
      audienceKind: 'everyone',
      audienceName: null,
      sortOrder: 0,
      sidebar: { componentIds: components.map(({ id }) => id) },
      dashboard: {
        tiles: components.map(({ id, type }, index) => ({
          id: randomUUID(),
          kind: 'widget' as const,
          componentId: id,
          widgetKey: Object.keys(COMPONENT_WIDGETS[type as ComponentType])[0]!,
          x: index * 4,
          y: 0,
          w: 4,
          h: 6
        }))
      }
    })
    console.log('Inserted example layout preset')
  } else {
    console.log('Everyone layout preset exists or component catalogue is empty; skipped seed')
  }
} finally {
  await client.end()
}
