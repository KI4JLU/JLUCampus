import { TRANSCRIPTION_DEFAULT_CONFIG } from '@justcampus/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { loadModuleRuntime } from '../../runtime.js'
import { sweepTranscripts } from './retention.js'
import { deleteTranscripts, staleTranscriptIds } from './store.js'
import { COMPONENT_ID, NO_SECRETS } from './testing.js'

vi.mock('../../runtime.js', () => ({ loadModuleRuntime: vi.fn() }))
vi.mock('./store.js', () => ({ staleTranscriptIds: vi.fn(), deleteTranscripts: vi.fn() }))

function runtime(
  transcriptRetentionHours: number | null
): Awaited<ReturnType<typeof loadModuleRuntime<'transcription'>>> {
  return {
    type: 'transcription' as const,
    componentId: COMPONENT_ID,
    config: { ...TRANSCRIPTION_DEFAULT_CONFIG, transcriptRetentionHours },
    secrets: NO_SECRETS
  }
}

beforeEach(() => {
  vi.mocked(staleTranscriptIds).mockReset()
  vi.mocked(deleteTranscripts).mockReset()
})

describe('sweepTranscripts', () => {
  it('keeps saved transcripts until the user deletes them unless the admin sets a period', async () => {
    vi.mocked(loadModuleRuntime).mockResolvedValue(runtime(null))
    expect(await sweepTranscripts()).toBe(0)
    vi.mocked(loadModuleRuntime).mockResolvedValue(null)
    expect(await sweepTranscripts()).toBe(0)
    expect(staleTranscriptIds).not.toHaveBeenCalled()
  })

  it('deletes transcripts last changed before the period, also of a disabled module', async () => {
    vi.mocked(loadModuleRuntime).mockResolvedValue(runtime(48))
    vi.mocked(staleTranscriptIds).mockResolvedValueOnce(['a', 'b']).mockResolvedValue([])
    vi.mocked(deleteTranscripts).mockResolvedValue(2)
    const now = new Date('2026-10-04T12:00:00Z')
    expect(await sweepTranscripts(now)).toBe(2)
    expect(loadModuleRuntime).toHaveBeenLastCalledWith('transcription', expect.anything(), false)
    expect(staleTranscriptIds).toHaveBeenCalledWith(
      COMPONENT_ID,
      new Date('2026-10-02T12:00:00Z'),
      expect.any(Number)
    )
    expect(deleteTranscripts).toHaveBeenCalledWith(COMPONENT_ID, null, ['a', 'b'])
  })
})
