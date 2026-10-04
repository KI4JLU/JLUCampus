import { describe, expect, it } from 'vitest'
import { LiveEventProcessor } from './events'

const delta = (itemId: string, text: string): unknown => ({
  type: 'conversation.item.input_audio_transcription.delta',
  item_id: itemId,
  delta: text
})
const completed = (itemId: string | undefined, transcript: string): unknown => ({
  type: 'conversation.item.input_audio_transcription.completed',
  item_id: itemId,
  transcript
})

/** Everything the events append, in order. */
function transcript(events: unknown[]): string {
  const processor = new LiveEventProcessor()
  return events.map((event) => processor.handle(event).text ?? '').join('')
}

describe('LiveEventProcessor', () => {
  it('shows a delta followed by the identical completion once', () => {
    expect(transcript([delta('a', 'Guten Tag.'), completed('a', 'Guten Tag.')])).toBe('Guten Tag. ')
  })

  it('appends only the tail the deltas did not deliver', () => {
    expect(
      transcript([delta('a', 'Guten'), delta('a', ' Tag'), completed('a', 'Guten Tag, Gießen.')])
    ).toBe('Guten Tag, Gießen. ')
  })

  it('does not append a final text that diverges from the streamed one', () => {
    expect(transcript([delta('a', 'Guten Tach'), completed('a', 'Guten Tag.')])).toBe('Guten Tach ')
  })

  it('appends a completion without deltas in full', () => {
    expect(transcript([completed('a', 'Hallo.'), completed(undefined, 'Welt.')])).toBe(
      'Hallo. Welt. '
    )
  })

  it('keeps the items apart', () => {
    expect(
      transcript([
        delta('a', 'Eins'),
        delta('b', 'Zwei'),
        completed('b', 'Zwei.'),
        completed('a', 'Eins.')
      ])
    ).toBe('EinsZwei. . ')
  })

  it('takes the transcript of a finished item as fallback', () => {
    expect(
      transcript([
        {
          type: 'conversation.item.done',
          item: { content: [{ transcript: 'Hallo' }, { text: 'Welt' }, { type: 'audio' }] }
        }
      ])
    ).toBe('Hallo Welt ')
  })

  it('tracks committed items until they complete or fail', () => {
    const processor = new LiveEventProcessor()
    processor.handle({ type: 'input_audio_buffer.committed', item_id: 'a' })
    processor.handle({ type: 'input_audio_buffer.committed', item_id: 'b' })
    expect(processor.handle(completed('a', 'x')).drained).toBe(false)
    const failed = processor.handle({
      type: 'conversation.item.input_audio_transcription.failed',
      item_id: 'b',
      error: { message: 'Upstream timeout' }
    })
    expect(failed).toMatchObject({ drained: true, sealed: true, error: 'Upstream timeout' })
  })

  it('reports service errors without ending anything', () => {
    const processor = new LiveEventProcessor()
    expect(processor.handle({ type: 'error', error: { message: 'Rate limit' } })).toEqual({
      text: null,
      drained: false,
      sealed: false,
      error: 'Rate limit'
    })
  })

  it('ignores unknown and malformed events', () => {
    const processor = new LiveEventProcessor()
    expect(processor.handle(null).text).toBeNull()
    expect(processor.handle({ type: 'session.created' }).text).toBeNull()
    expect(processor.handle(delta('a', '')).text).toBeNull()
  })
})
