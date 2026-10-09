import { describe, expect, it } from 'vitest'
import { leavesHint, pageControlBeside, type AnchorRelation } from './hint-focus'

const hint = ['close', 'got-it']

// The page in reading order around an anchor that contains a control of its own.
const page = ['search', 'anchor', 'anchor-child', 'next-link', 'footer']
const relations: Record<string, AnchorRelation> = {
  search: 'before',
  anchor: 'self',
  'anchor-child': 'inside',
  'next-link': 'after',
  footer: 'after'
}
const relation = (control: string): AnchorRelation => relations[control] ?? 'before'

describe('leavesHint', () => {
  it('leaves forward from the last control only', () => {
    expect(leavesHint(hint, 'got-it', false)).toBe(true)
    expect(leavesHint(hint, 'close', false)).toBe(false)
  })

  it('leaves backward from the first control or the hint itself', () => {
    expect(leavesHint(hint, 'close', true)).toBe(true)
    expect(leavesHint(hint, 'hint-container', true)).toBe(true)
    expect(leavesHint(hint, 'got-it', true)).toBe(false)
  })

  it('moves into the hint when Tab starts on the hint itself', () => {
    expect(leavesHint(hint, 'hint-container', false)).toBe(false)
  })

  it('always leaves a hint without controls', () => {
    expect(leavesHint([], 'hint-container', false)).toBe(true)
  })
})

describe('pageControlBeside', () => {
  it('goes on to the first control after the anchor and its content', () => {
    expect(pageControlBeside(page, relation, false)).toBe('next-link')
  })

  it('goes back to the anchor when it takes focus', () => {
    expect(pageControlBeside(page, relation, true)).toBe('anchor')
  })

  it('goes back to the last control in or before an anchor that takes no focus', () => {
    const withoutAnchor = page.filter((control) => control !== 'anchor')
    expect(pageControlBeside(withoutAnchor, relation, true)).toBe('anchor-child')
    expect(pageControlBeside(['search', 'footer'], relation, true)).toBe('search')
  })

  it('finds nothing past the end or before the start of the page', () => {
    expect(pageControlBeside(['search', 'anchor'], relation, false)).toBeNull()
    expect(pageControlBeside(['footer'], relation, true)).toBeNull()
  })
})
