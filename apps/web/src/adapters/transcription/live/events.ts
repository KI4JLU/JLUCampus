/**
 * The OpenAI realtime transcription events, as kiChat's `realtime_transcription.js` reads them
 * (section 3, T-60). Both the on-prem bridge and OpenAI send them over the `oai-events` channel.
 * Deltas append at once; a completed transcript appends only what its deltas did not deliver, so a
 * delta followed by the identical completion appears once. Committed items stay pending until they
 * complete or fail, which is what stopping waits for.
 */

export interface LiveEventEffect {
  /** Text to append to the running transcript. */
  text: string | null
  /** Whether this event ended the last pending item (stopping may close now). */
  drained: boolean
  /** Whether an item got its final transcript or failed. */
  sealed: boolean
  /** A service error to show; the session goes on. */
  error: string | null
}

const NOTHING: LiveEventEffect = { text: null, drained: false, sealed: false, error: null }

type Fields = Record<string, unknown>

function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null
}

function stringField(fields: Fields, key: string): string | null {
  const value = fields[key]
  return typeof value === 'string' ? value : null
}

function errorMessage(value: unknown): string | null {
  if (typeof value === 'string') return value || null
  if (isFields(value)) return stringField(value, 'message')
  return null
}

export class LiveEventProcessor {
  /** Items committed for transcription and not yet completed or failed. */
  readonly pending = new Set<string>()
  /** Item id → text already delivered by its deltas. */
  private readonly delivered = new Map<string, string>()

  /** Handles one parsed message of the data channel. */
  handle(event: unknown): LiveEventEffect {
    if (!isFields(event)) return NOTHING
    const itemId = stringField(event, 'item_id')

    switch (event.type) {
      case 'input_audio_buffer.committed':
        if (itemId) this.pending.add(itemId)
        return NOTHING

      case 'conversation.item.input_audio_transcription.delta': {
        const delta = stringField(event, 'delta') ?? ''
        if (itemId) this.delivered.set(itemId, (this.delivered.get(itemId) ?? '') + delta)
        return { ...NOTHING, text: delta || null }
      }

      case 'conversation.item.input_audio_transcription.completed': {
        const transcript = stringField(event, 'transcript') ?? ''
        const delivered = itemId ? (this.delivered.get(itemId) ?? '') : ''
        if (itemId) this.delivered.delete(itemId)
        // Only the missing tail; a final text that differs from the streamed one entirely is not
        // appended again, that would duplicate it.
        const remainder = transcript.startsWith(delivered)
          ? transcript.slice(delivered.length)
          : delivered
            ? ''
            : transcript
        return {
          ...this.resolve(itemId),
          text: remainder || delivered ? `${remainder} ` : null
        }
      }

      case 'conversation.item.input_audio_transcription.failed':
        if (itemId) this.delivered.delete(itemId)
        return { ...this.resolve(itemId), error: errorMessage(event.error) }

      case 'conversation.item.done': {
        // Fallback: a finished item may carry its transcript in its content.
        const item = isFields(event.item) ? event.item : null
        const content = Array.isArray(item?.content) ? item.content : []
        const text = content
          .map((part) =>
            isFields(part) ? (stringField(part, 'transcript') ?? stringField(part, 'text')) : null
          )
          .filter((part): part is string => Boolean(part))
          .map((part) => `${part} `)
          .join('')
        return { ...NOTHING, text: text || null }
      }

      case 'error':
        return { ...NOTHING, error: errorMessage(event.error) ?? errorMessage(event.message) }

      default:
        return NOTHING
    }
  }

  /** Forgets everything, when the connection closes. */
  clear(): void {
    this.pending.clear()
    this.delivered.clear()
  }

  /** One completed or failed item; an item never seen committed still ends the wait. */
  private resolve(itemId: string | null): LiveEventEffect {
    if (itemId) this.pending.delete(itemId)
    return { ...NOTHING, sealed: true, drained: this.pending.size === 0 }
  }
}
