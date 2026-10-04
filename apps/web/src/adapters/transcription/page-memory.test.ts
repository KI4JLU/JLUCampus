import { describe, expect, it, vi } from 'vitest'
import { MemoryCell, PageMemory } from './page-memory'

describe('MemoryCell', () => {
  it('sets values and updates, and tells its subscribers of changes only', () => {
    const cell = new MemoryCell(1)
    const listener = vi.fn()
    const unsubscribe = cell.subscribe(listener)
    cell.set(2)
    cell.set((current) => current + 1)
    cell.set(3)
    expect(cell.get()).toBe(3)
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    cell.set(4)
    expect(listener).toHaveBeenCalledTimes(2)
  })
})

describe('PageMemory', () => {
  it('keeps one cell per key, created once', () => {
    const memory = new PageMemory()
    const initial = vi.fn(() => ['take'])
    const first = memory.cell('takes', initial)
    first.set(['take', 'second'])
    expect(memory.cell('takes', initial).value).toEqual(['take', 'second'])
    expect(initial).toHaveBeenCalledTimes(1)
  })

  it('runs its disposers once, newest first, and at once after it ended', () => {
    const memory = new PageMemory()
    const calls: string[] = []
    memory.onDispose(() => calls.push('queue'))
    memory.onDispose(() => calls.push('microphone'))
    memory.dispose()
    memory.dispose()
    expect(calls).toEqual(['microphone', 'queue'])
    expect(memory.disposed).toBe(true)
    memory.onDispose(() => calls.push('late'))
    expect(calls).toEqual(['microphone', 'queue', 'late'])
  })
})
