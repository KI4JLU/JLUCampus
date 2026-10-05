import { clientEvents } from './protocol.js'

/**
 * The items of a live session as the browser sees them, for both modes: the one place that
 * decides what the browser hears about an item.
 *
 * An item is open from the moment audio of it is known (vLLM: its first audio or its first
 * commit; OpenAI: the gateway's `input_audio_buffer.committed`) until it ends with `…completed`
 * or `…failed`; then it is retired. The browser hears `input_audio_buffer.committed` at most once
 * per item (`announce`), deltas only while it is open, and of a retired item nothing again: a
 * transcript that comes after the server failed it (`expire`) neither fails it twice nor starts a
 * fresh text the browser would append to what it showed already. Ids the gateway never opened
 * carry nothing to the browser, so whatever the browser keeps per item is bounded by the open
 * items.
 *
 * Both are bounded, and so is the guarantee: open items are `max` at most, retired ids are
 * remembered for the last `4 * max` (16 at least; 128 by default) retired items. Within that
 * window an item ends once and a repeated `…committed` of a retired id is `known`. An id retired
 * longer ago is forgotten: the gateway committing it again opens it as a new item, which then
 * ends once more (a second outcome, its text shown again). That takes a gateway repeating an id
 * of over a hundred items before; remembering every id of a session instead would let a gateway
 * grow the server's memory without bound.
 */

type Emit = (event: unknown) => void

interface OpenItem {
  announced: boolean
  /** When it fails unless it ended before (`expire`); `null` for an item without deadline. */
  deadline: number | null
}

export type OpenResult = 'opened' | 'known' | 'full'

export class LiveItems {
  private readonly open = new Map<string, OpenItem>()
  private readonly retired = new Set<string>()
  private readonly retiredMax: number

  constructor(
    private readonly emit: Emit,
    private readonly max: number
  ) {
    this.retiredMax = Math.max(4 * max, 16)
  }

  /** Items open; the drain is complete once none is. */
  get size(): number {
    return this.open.size
  }

  isOpen(id: string): boolean {
    return this.open.has(id)
  }

  /**
   * Opens `id` (`opened`); an id open or retired already (and still remembered) is `known` and
   * changes nothing, one beyond `max` open items is `full` and is not opened.
   */
  track(id: string, deadline: number | null = null): OpenResult {
    if (this.open.has(id) || this.retired.has(id)) return 'known'
    if (this.open.size >= this.max) return 'full'
    this.open.set(id, { announced: false, deadline })
    return 'opened'
  }

  /** Tells the browser to wait for an open item, once. */
  announce(id: string): void {
    const item = this.open.get(id)
    if (!item || item.announced) return
    item.announced = true
    this.emit(clientEvents.committed(id))
  }

  delta(id: string, delta: string): void {
    if (delta && this.open.has(id)) this.emit(clientEvents.delta(id, delta))
  }

  /** Its transcript; whether it was open (the browser got it). */
  complete(id: string, transcript: string): boolean {
    if (!this.retire(id)) return false
    this.emit(clientEvents.completed(id, transcript))
    return true
  }

  /** Fails it; whether it was open (the browser got `…failed`). */
  fail(id: string): boolean {
    if (!this.retire(id)) return false
    this.emit(clientEvents.failed(id))
    return true
  }

  /** Fails every open item whose deadline passed; their ids. */
  expire(now: number): string[] {
    const expired = [...this.open]
      .filter(([, item]) => item.deadline !== null && now >= item.deadline)
      .map(([id]) => id)
    for (const id of expired) this.fail(id)
    return expired
  }

  /** Fails every open item; how many there were. */
  failAll(): number {
    const ids = [...this.open.keys()]
    for (const id of ids) this.fail(id)
    return ids.length
  }

  /** Forgets everything, when the session closed (the browser hears nothing more anyway). */
  clear(): void {
    this.open.clear()
    this.retired.clear()
  }

  private retire(id: string): boolean {
    if (!this.open.delete(id)) return false
    this.retired.add(id)
    if (this.retired.size > this.retiredMax) {
      this.retired.delete(this.retired.values().next().value!)
    }
    return true
  }
}
