import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The SQL the cleanup, save and analysis send (F-2). No database runs here: a postgres client
 * double records each statement and answers no rows, so these tests check the conditions that
 * serialise the cleanup with saving and expiry extension, not Postgres itself.
 */

const queries = vi.hoisted(() => [] as string[])

vi.mock('../../../db/index.js', async () => {
  const { drizzle } = await import('drizzle-orm/postgres-js')
  const schema = await import('../../../db/schema.js')
  const answer = (): Promise<unknown[]> & { values: () => Promise<unknown[]> } =>
    Object.assign(Promise.resolve([]), { values: () => Promise.resolve([]) })
  const client = {
    options: { parsers: {}, serializers: {} },
    unsafe: (query: string) => {
      queries.push(query)
      return answer()
    },
    begin: async (run: (transaction: unknown) => Promise<unknown>) => run(client)
  }
  return { db: drizzle(client as never, { schema }), client }
})

const { claimJobsForCleanup, existingJobs, transitionJob } = await import('./store.js')
const { saveTranscript } = await import('../transcripts/store.js')

const now = new Date('2026-10-04T12:00:00.000Z')

function occurrences(text: string, part: string): number {
  return text.split(part).length - 1
}

beforeEach(() => {
  queries.length = 0
})

describe('cleanup claim (F-2)', () => {
  it('marks due jobs deleted in one conditional update before any object goes', async () => {
    await claimJobsForCleanup(now, 120_000, new Date(now.getTime() - 3_600_000))
    expect(queries).toHaveLength(1)
    const [claim] = queries as [string]
    expect(claim).toMatch(
      /^update "transcription_job" set "deleted_at" = coalesce\("transcription_job"\."deleted_at"/
    )
    expect(claim).toContain('for update skip locked')
    // The condition runs in the locking subquery and again on the row as the lock leaves it, so a
    // job saved or given a new expiry meanwhile is not claimed.
    expect(occurrences(claim, '"transcription_job"."transcript_id" is null')).toBe(4)
    expect(occurrences(claim, '"transcription_job"."expires_at" <')).toBe(2)
    expect(claim).toContain('returning "id", "component_id"')
  })

  it('lets the orphan sweep keep every job that has a row, whatever its state', async () => {
    await existingJobs(['11111111-1111-4111-8111-111111111111'])
    const [query] = queries as [string]
    expect(query).toContain('where "transcription_job"."id" in')
    expect(query).not.toContain('deleted_at')
    expect(query).not.toContain('expires_at')
  })
})

describe('what a claimed job no longer accepts (F-2)', () => {
  it('locks only jobs neither deleted nor expired when saving', async () => {
    const build = vi.fn(() => {
      throw new Error('refused')
    })
    await expect(
      saveTranscript('c', 'u', 'key', ['11111111-1111-4111-8111-111111111111'], build)
    ).rejects.toThrow('refused')
    expect(build).toHaveBeenCalledWith([])
    const lock = queries.find((query) => query.endsWith('for update'))
    expect(lock).toBeDefined()
    expect(lock).toContain('"transcription_job"."deleted_at" is null')
    expect(lock).toContain('"transcription_job"."expires_at" >')
  })

  it('extends no expiry of a deleted or expired job in an analysis or dispatch', async () => {
    await transitionJob('11111111-1111-4111-8111-111111111111', ['analyzed'], {
      status: 'analyzingQueued',
      expiresAt: new Date(now.getTime() + 86_400_000),
      updatedAt: now
    })
    const [update] = queries as [string]
    expect(update).toMatch(/^update "transcription_job" set/)
    expect(update).toContain('"transcription_job"."deleted_at" is null')
    expect(update).toContain('"transcription_job"."expires_at" >')
  })
})
