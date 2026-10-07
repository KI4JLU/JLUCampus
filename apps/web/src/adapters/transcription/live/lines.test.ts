import { describe, expect, it } from 'vitest'
import {
  appendLiveTranscriptText,
  EMPTY_LIVE_TRANSCRIPT_WINDOW,
  liveTranscriptRows,
  type LiveTranscriptWindow
} from './lines'

function append(...chunks: string[]): LiveTranscriptWindow {
  return chunks.reduce(appendLiveTranscriptText, EMPTY_LIVE_TRANSCRIPT_WINDOW)
}

describe('the live transcript’s rolling window', () => {
  it('keeps short text on the current line', () => {
    expect(liveTranscriptRows(append('Hallo ', 'Welt'))).toEqual({
      older: '',
      prev: '',
      current: 'Hallo Welt'
    })
  })

  it('ignores empty chunks', () => {
    const window = append('Hallo')
    expect(appendLiveTranscriptText(window, '')).toBe(window)
  })

  it('wraps at the last space within 42 characters and trims both sides of the break', () => {
    const window = append('Dies ist ein kurzer Test, der zeigt, wie   der Text umbricht.')
    // The space at index 42 counts: `lastIndexOf(' ', 42)`.
    expect(window.lines).toEqual(['Dies ist ein kurzer Test, der zeigt, wie'])
    expect(window.current).toBe('der Text umbricht.')
  })

  it('cuts hard at 42 characters when the line has no space to break at', () => {
    const word = 'x'.repeat(50)
    expect(append(word)).toEqual({ lines: ['x'.repeat(42)], current: 'x'.repeat(8) })
    // A leading space is no break point either.
    expect(append(` ${word}`)).toEqual({
      lines: [` ${'x'.repeat(41)}`],
      current: 'x'.repeat(9)
    })
  })

  it('keeps only the current line and the two before it', () => {
    const sentence = (n: number): string => `Satz ${n} ist genau so lang wie die anderen. `
    const window = append(sentence(1), sentence(2), sentence(3), sentence(4))
    expect(liveTranscriptRows(window)).toEqual({
      older: 'Satz 2 ist genau so lang wie die anderen.',
      prev: 'Satz 3 ist genau so lang wie die anderen.',
      current: 'Satz 4 ist genau so lang wie die anderen. '
    })
  })

  it('trims only what the chunk that broke the line brought, as kiChat does', () => {
    // In one chunk the spaces after the break go.
    expect(append(`${'a'.repeat(42)}  Hallo`)).toEqual({
      lines: ['a'.repeat(42)],
      current: 'Hallo'
    })
    // A completion's trailing space breaks the line; the next delta's leading space stays.
    expect(append(`${'a'.repeat(42)} `, ' Hallo')).toEqual({
      lines: ['a'.repeat(42)],
      current: ' Hallo'
    })
  })
})
