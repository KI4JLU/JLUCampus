import { describe, expect, it } from 'vitest'
import { firstEligible } from './use-visible-target'

/** Stand-ins for elements: what each hint's selector finds, and which of them are on screen. */
const queue = [
  { hint: 'oldest', elements: ['sidebar-row'] },
  { hint: 'middle', elements: [] as string[] },
  { hint: 'newest', elements: ['hidden-copy', 'add-widget'] }
]
const groups = queue.map((entry) => entry.elements)

describe('firstEligible', () => {
  it('shows the first hint whose element is on screen', () => {
    expect(firstEligible(groups, () => true)).toEqual({ index: 0, item: 'sidebar-row' })
  })

  it('moves on when the first hint’s element is off screen or missing', () => {
    const onScreen = new Set(['add-widget'])
    expect(firstEligible(groups, (element) => onScreen.has(element))).toEqual({
      index: 2,
      item: 'add-widget'
    })
  })

  it('takes the first element of a selector that is on screen, not merely the first match', () => {
    const onScreen = new Set(['add-widget'])
    expect(firstEligible([groups[2] ?? []], (element) => onScreen.has(element))).toEqual({
      index: 0,
      item: 'add-widget'
    })
  })

  it('shows nothing while no element is on screen', () => {
    expect(firstEligible(groups, () => false)).toBeNull()
    expect(firstEligible([], () => true)).toBeNull()
  })
})
