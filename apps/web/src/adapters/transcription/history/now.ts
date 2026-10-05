import { useSyncExternalStore } from 'react'

/** How often the history's date groups are recomputed. */
const TICK_MS = 60_000

let now = Date.now()
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!timer) {
    now = Date.now()
    timer = setInterval(() => {
      now = Date.now()
      listeners.forEach((notify) => notify())
    }, TICK_MS)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  }
}

/** The current time, updated every minute: today's entries move to yesterday at midnight. */
export function useNow(): number {
  return useSyncExternalStore(
    subscribe,
    () => now,
    () => now
  )
}
