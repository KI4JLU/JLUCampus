import { useEffect, useState, useSyncExternalStore } from 'react'
import { useRouter } from '@tanstack/react-router'

/**
 * State of the transcription page that outlives a remount of the page. DS gap: AppShellLayout
 * renders its content in another tree below and above `lg`, and on narrow screens not at all
 * while its navigation tab is shown, so a resized window, a turned tablet or a look at the
 * navigation remounts the page. A running recording, the upload queue and the open view must
 * survive that, so they live here, one memory per component, until the user has left the page's
 * address.
 */

type Listener = () => void
type Update<T> = T | ((current: T) => T)

/** One value with subscribers, for `useSyncExternalStore`; it can be set while nothing renders. */
export class MemoryCell<T> {
  private listeners = new Set<Listener>()

  constructor(public value: T) {}

  readonly get = (): T => this.value

  readonly set = (update: Update<T>): void => {
    const next = typeof update === 'function' ? (update as (current: T) => T)(this.value) : update
    if (Object.is(next, this.value)) return
    this.value = next
    for (const listener of this.listeners) listener()
  }

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

export class PageMemory {
  private readonly cells = new Map<string, MemoryCell<unknown>>()
  private readonly disposers: (() => void)[] = []
  private ended = false

  /** Whether the page was left for good; nothing kept here runs on after that. */
  get disposed(): boolean {
    return this.ended
  }

  /** The value kept under `key`, created by `initial` the first time. */
  cell<T>(key: string, initial: () => T): MemoryCell<T> {
    let cell = this.cells.get(key) as MemoryCell<T> | undefined
    if (!cell) {
      cell = new MemoryCell(initial())
      this.cells.set(key, cell as MemoryCell<unknown>)
    }
    return cell
  }

  /** Runs `dispose` when the page is left for good; at once if it already was. */
  onDispose(dispose: () => void): void {
    if (this.ended) dispose()
    else this.disposers.push(dispose)
  }

  dispose(): void {
    if (this.ended) return
    this.ended = true
    for (const dispose of this.disposers.splice(0).reverse()) dispose()
    this.cells.clear()
  }
}

interface Entry {
  memory: PageMemory
  /** Mounted pages holding it. */
  holders: number
  /** Ends the watch for leaving the page, while none holds it. */
  unwatch: (() => void) | null
}

const entries = new Map<string, Entry>()

/** Whether `pathname` is the page of this component. */
function onPage(pathname: string, componentId: string): boolean {
  const path = `/c/${componentId}`
  return pathname === path || pathname.startsWith(`${path}/`)
}

type Router = ReturnType<typeof useRouter>

/** A mounted page takes its memory; the watch for leaving ends. */
function hold(entry: Entry): void {
  entry.holders += 1
  entry.unwatch?.()
  entry.unwatch = null
}

/**
 * A page lets its memory go. Once none holds it, it is disposed as soon as the address is no
 * longer the page's: checked after the current task (a remount takes it back before) and at
 * every navigation.
 */
function release(entry: Entry, componentId: string, router: Router): void {
  entry.holders -= 1
  if (entry.holders > 0) return
  const check = (): void => {
    if (entry.holders > 0 || entry.memory.disposed) return
    if (onPage(router.state.location.pathname, componentId)) return
    entry.unwatch?.()
    entry.unwatch = null
    if (entries.get(componentId) === entry) entries.delete(componentId)
    entry.memory.dispose()
  }
  const timer = setTimeout(check, 0)
  const unsubscribe = router.subscribe('onResolved', check)
  entry.unwatch = () => {
    clearTimeout(timer)
    unsubscribe()
  }
}

/** The page's memory: the same one after a remount, a new one after the user left the page. */
export function usePageMemory(componentId: string): PageMemory {
  const router = useRouter()
  const [entry] = useState<Entry>(() => {
    const kept = entries.get(componentId)
    if (kept) return kept
    const created: Entry = { memory: new PageMemory(), holders: 0, unwatch: null }
    entries.set(componentId, created)
    return created
  })

  useEffect(() => {
    // A memory let go in between is not taken back; the page remounts with a fresh one.
    if (entry.memory.disposed) return
    hold(entry)
    return () => release(entry, componentId, router)
  }, [componentId, entry, router])

  return entry.memory
}

/** A kept value as state: renders with it, and sets it for every page that shows it. */
export function useMemoryCell<T>(cell: MemoryCell<T>): [T, (update: Update<T>) => void] {
  const value = useSyncExternalStore(cell.subscribe, cell.get, cell.get)
  return [value, cell.set]
}
