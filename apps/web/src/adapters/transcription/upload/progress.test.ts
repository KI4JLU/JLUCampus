import { describe, expect, it } from 'vitest'
import type { TranscriptionProgress } from '@justcampus/shared'
import { creepStep, transcriptionDisplay, uploadProgress } from './progress'

const progress = (change: Partial<TranscriptionProgress>): TranscriptionProgress => ({
  phase: 'transcribing',
  currentChunk: 0,
  totalChunks: 0,
  percent: null,
  ...change
})

describe('progress (T-11)', () => {
  it('maps the upload to 2 to 50 %', () => {
    expect(uploadProgress(0)).toBe(2)
    expect(uploadProgress(0.5)).toBe(26)
    expect(uploadProgress(1)).toBe(50)
    expect(uploadProgress(Number.NaN)).toBe(2)
    expect(uploadProgress(3)).toBe(50)
  })

  it('creeps towards a cap without reaching it', () => {
    let value = 50
    for (let step = 0; step < 200; step++) value = creepStep(value, 98)
    expect(value).toBeLessThanOrEqual(98)
    expect(value).toBeGreaterThan(90)
    expect(creepStep(50, 98)).toBe(52.9)
  })

  it('never divides by a total of zero', () => {
    const shown = transcriptionDisplay({ status: 'transcribing', progress: progress({}) })
    expect(shown).toEqual({ progress: 60, status: 'transcribing' })
    expect(
      transcriptionDisplay({ status: 'transcribing', progress: progress({ phase: 'diarizing' }) })
    ).toEqual({ progress: 90, status: 'speakerAssignment' })
  })

  it('follows chunks, phases and the server estimate', () => {
    expect(
      transcriptionDisplay({
        status: 'transcribing',
        progress: progress({ currentChunk: 2, totalChunks: 4 })
      })
    ).toEqual({ progress: 70, status: 'transcribing' })
    expect(
      transcriptionDisplay({
        status: 'transcribing',
        progress: progress({ phase: 'diarizing', currentChunk: 3, totalChunks: 4 })
      })
    ).toEqual({ progress: 89, status: 'speakerAssignment' })
    expect(
      transcriptionDisplay({ status: 'transcribing', progress: progress({ percent: 50 }) })
    ).toEqual({ progress: 65, status: 'transcribing' })
    expect(transcriptionDisplay({ status: 'optimizing', progress: null })).toEqual({
      progress: 95,
      status: 'speakerAssignment'
    })
    expect(transcriptionDisplay({ status: 'transcribing', progress: null })).toEqual({
      progress: 40,
      status: 'preparing'
    })
  })

  it('creeps through preprocessing and waits after it', () => {
    expect(transcriptionDisplay({ status: 'preprocessing', progress: null })).toEqual({
      progress: 8,
      status: 'preprocessing',
      creepTo: 33
    })
    expect(transcriptionDisplay({ status: 'preprocessed', progress: null })).toEqual({
      progress: 35,
      status: 'preprocessing'
    })
    expect(transcriptionDisplay({ status: 'analyzed', progress: null })).toBeNull()
  })
})
