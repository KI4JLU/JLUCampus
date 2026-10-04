import { describe, expect, it } from 'vitest'
import { percentText } from './texts'

describe('percentText (T-11)', () => {
  it('writes the rounded, bounded progress as the language writes a percentage', () => {
    expect(percentText('de', 41.6)).toBe('42 %')
    expect(percentText('en', 41.6)).toBe('42%')
    expect(percentText('en', 140)).toBe('100%')
    expect(percentText('en', -3)).toBe('0%')
  })
})
