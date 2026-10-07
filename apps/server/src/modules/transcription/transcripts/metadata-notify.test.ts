import { TRANSCRIPTION_DEFAULT_CONFIG } from '@justcampus/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  notify: vi.fn(),
  target: vi.fn(),
  complete: vi.fn(),
  apply: vi.fn()
}))
vi.mock('../../../db/index.js', () => ({ client: { notify: state.notify } }))
vi.mock('../events/hub.js', () => ({ TRANSCRIPTION_EVENTS_CHANNEL: 'transcription_events' }))
vi.mock('../summaries/chat.js', () => ({
  chatTarget: state.target,
  complete: state.complete,
  withoutThinking: (value: string) => value
}))
vi.mock('./store.js', () => ({ applyGeneratedMetadata: state.apply }))

import { generateMetadataAfterSave } from './metadata.js'

const runtime = {
  config: TRANSCRIPTION_DEFAULT_CONFIG,
  secrets: { apiKey: null, diarizationApiKey: null, llmApiKey: null, openaiRealtimeApiKey: null }
}
const transcript = {
  id: 'transcript',
  componentId: 'component',
  userId: 'user',
  title: 'A chosen title',
  originalFilename: null,
  userLocale: null,
  segments: [{ start: 0, end: 1, speaker: null, text: 'Meeting text', redactions: [] }]
}

beforeEach(() => {
  state.notify.mockReset().mockResolvedValue(undefined)
  state.target.mockReset().mockReturnValue({})
  state.complete.mockReset().mockResolvedValue('Meeting subtitle')
  state.apply.mockReset().mockResolvedValue(undefined)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('metadata completion notification', () => {
  it.each(['generated', 'no target', 'generation failed', 'storage failed', 'empty transcript'])(
    'notifies after %s',
    async (scenario) => {
      if (scenario === 'no target') state.target.mockReturnValue(null)
      if (scenario === 'generation failed') state.complete.mockRejectedValue(new Error('upstream'))
      if (scenario === 'storage failed') state.apply.mockRejectedValue(new Error('database'))
      await generateMetadataAfterSave(runtime, {
        ...transcript,
        segments: scenario === 'empty transcript' ? [] : transcript.segments
      })
      expect(state.notify).toHaveBeenCalledExactlyOnceWith(
        'transcription_events',
        JSON.stringify({
          type: 'transcriptMetadata',
          id: 'transcript',
          componentId: 'component',
          userId: 'user'
        })
      )
      if (scenario === 'generated') {
        expect(state.apply).toHaveBeenCalledWith('transcript', {
          title: null,
          subtitle: 'Meeting subtitle',
          titleWas: transcript.title
        })
        expect(state.apply.mock.invocationCallOrder[0]).toBeLessThan(
          state.notify.mock.invocationCallOrder[0]!
        )
      }
    }
  )

  it('logs notify failures without rejecting background work', async () => {
    state.notify.mockRejectedValue(new Error('connection lost'))
    await expect(generateMetadataAfterSave(runtime, transcript)).resolves.toBeUndefined()
    expect(console.error).toHaveBeenCalledWith(
      'Transcription metadata notification failed',
      'transcript',
      expect.any(Error)
    )
  })
})
