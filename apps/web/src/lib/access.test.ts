import { describe, expect, it } from 'vitest'
import { accessChanged } from './access'

const C1 = '00000000-0000-4000-8000-000000000001'
const C2 = '00000000-0000-4000-8000-000000000002'

describe('accessChanged', () => {
  const before = { componentIds: [C1, C2], features: ['translator.rephrase' as const] }

  it('ignores the order of the lists', () => {
    expect(accessChanged(before, { ...before, componentIds: [C2, C1] })).toBe(false)
  })

  it('sees a component taken away or added', () => {
    expect(accessChanged(before, { ...before, componentIds: [C1] })).toBe(true)
    expect(accessChanged({ ...before, componentIds: [C1] }, before)).toBe(true)
  })

  it('sees a function taken away or swapped for another', () => {
    expect(accessChanged(before, { ...before, features: [] })).toBe(true)
    expect(accessChanged(before, { ...before, features: ['translator.documents'] })).toBe(true)
  })
})
