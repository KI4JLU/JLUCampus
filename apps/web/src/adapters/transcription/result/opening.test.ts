import { describe, expect, it } from 'vitest'
import type { TranscriptionTranscript } from '@justcampus/shared'
import { formatExpiry, openingCopy } from './opening'

const copy = (revision: number): TranscriptionTranscript =>
  ({ id: 't', revision }) as TranscriptionTranscript

describe('openingCopy', () => {
  it('waits for the detail loaded since opening, even with an older one cached', () => {
    expect(openingCopy({ fresh: null, failed: false, kept: copy(1), earlier: copy(1) })).toBeNull()
    expect(openingCopy({ fresh: copy(2), failed: false, kept: copy(1), earlier: copy(1) })).toEqual(
      { transcript: copy(2), fallback: false }
    )
  })

  it('stands in with the newest kept copy after a transient failure, else gives up', () => {
    expect(openingCopy({ fresh: null, failed: true, kept: copy(3), earlier: copy(2) })).toEqual({
      transcript: copy(3),
      fallback: true
    })
    expect(openingCopy({ fresh: null, failed: true, kept: copy(1), earlier: copy(2) })).toEqual({
      transcript: copy(2),
      fallback: true
    })
    expect(openingCopy({ fresh: null, failed: true, kept: null, earlier: null })).toBeNull()
  })
})

describe('formatExpiry', () => {
  it('names date and time in the UI language', () => {
    expect(formatExpiry('2026-10-06T08:00:00.000Z', 'de')).toMatch(/2026/)
    expect(formatExpiry('nonsense', 'en')).toBe('nonsense')
  })
})
