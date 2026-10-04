import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import type { TranscriptionTranscript } from '@justcampus/shared'
import { transcriptQuery } from '../api'

/** Resolves once the observer has a result fetched since it subscribed. */
function open(
  client: QueryClient,
  options: ReturnType<typeof transcriptQuery>
): Promise<{ revision: number; close: () => void }> {
  const observer = new QueryObserver(client, options)
  return new Promise<{ revision: number; close: () => void }>((resolve) => {
    const close = observer.subscribe((result) => {
      if (result.isFetchedAfterMount && result.data) {
        resolve({ revision: result.data.revision, close })
      }
    })
  })
}

describe('transcriptQuery', () => {
  it('loads the detail again on every opening, not only the first (T-39)', async () => {
    const client = new QueryClient()
    let revision = 1
    let requests = 0
    const options = {
      ...transcriptQuery('t-1'),
      queryFn: async () => {
        requests++
        return { id: 't-1', revision } as TranscriptionTranscript
      }
    }
    const first = await open(client, options)
    expect(first.revision).toBe(1)
    first.close()
    revision = 2
    const second = await open(client, options)
    expect(second.revision).toBe(2)
    expect(requests).toBe(2)
    second.close()
    client.clear()
  })
})
