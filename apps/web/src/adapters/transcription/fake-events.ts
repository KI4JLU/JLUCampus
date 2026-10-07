import type { TranscriptionEvent } from '@justcampus/shared'
import type { TranscriptionEventHandlers, TranscriptionEvents } from './events'

/** A stand-in stream for tests, driven by hand. */
export interface FakeEvents extends TranscriptionEvents {
  /** Whether the stream is up; new subscribers hear `onOpen` right away then, as with the real. */
  open: boolean
  /** Sends an event to every subscriber; lost while the stream is down. */
  emit: (event: TranscriptionEvent) => void
  /** The stream drops (`false`) or (re)connects (`true`, every subscriber hears `onOpen`). */
  setOpen: (open: boolean) => void
  readonly subscribers: number
}

export function fakeEvents(open = true): FakeEvents {
  const subscribers = new Set<TranscriptionEventHandlers>()
  const each = (call: (handlers: TranscriptionEventHandlers) => void): void => {
    for (const handlers of [...subscribers]) if (subscribers.has(handlers)) call(handlers)
  }
  const fake: FakeEvents = {
    open,
    subscribe(handlers) {
      subscribers.add(handlers)
      if (fake.open) {
        queueMicrotask(() => {
          if (fake.open && subscribers.has(handlers)) handlers.onOpen?.()
        })
      }
      return () => {
        subscribers.delete(handlers)
      }
    },
    emit: (event) => {
      if (fake.open) each((handlers) => handlers.onEvent?.(event))
    },
    setOpen(next) {
      fake.open = next
      if (next) each((handlers) => handlers.onOpen?.())
    },
    get subscribers() {
      return subscribers.size
    }
  }
  return fake
}
