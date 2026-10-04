import { describe, expect, it } from 'vitest'

import {
  failedAfterDispatch,
  failureOf,
  forwardStatus,
  JobFailure,
  jobActions,
  progressOf,
  stageOf
} from './state.js'

describe('job state machine', () => {
  it('analyses after the upload and again after analysis or failure', () => {
    expect(jobActions('uploading', null)).toMatchObject({ analyze: true, dispatch: false })
    expect(jobActions('analyzed', null)).toMatchObject({ analyze: true, dispatch: true })
    expect(jobActions('analyzingQueued', null)).toMatchObject({
      analyze: false,
      analyzeRunning: true
    })
    expect(jobActions('analyzing', null).analyzeRunning).toBe(true)
    for (const status of ['preprocessing', 'transcribing', 'optimizing', 'completed'] as const) {
      expect(jobActions(status, null)).toEqual({
        analyze: false,
        analyzeRunning: false,
        dispatch: false
      })
    }
  })

  it('dispatches a failed job again only when its transcription failed', () => {
    const asr = { code: 'asr_failed', message: 'Status 503' } as const
    const analysis = { code: 'analysis_failed', message: 'Status 415' } as const
    expect(jobActions('failed', asr).dispatch).toBe(true)
    expect(jobActions('failed', analysis).dispatch).toBe(false)
    expect(jobActions('failed', analysis).analyze).toBe(true)
    expect(failedAfterDispatch({ code: 'unsupported_media', message: '' })).toBe(false)
    expect(failedAfterDispatch({ code: 'correction_failed', message: '' })).toBe(true)
    expect(failedAfterDispatch(null)).toBe(false)
  })

  it('runs the analysis for queued and running analyses, else the transcription', () => {
    expect(stageOf('analyzingQueued')).toBe('analysis')
    expect(stageOf('analyzing')).toBe('analysis')
    for (const status of ['preprocessing', 'preprocessed', 'transcribing', 'optimizing'] as const) {
      expect(stageOf(status)).toBe('transcription')
    }
  })

  it('never moves a resumed job back to an earlier status', () => {
    expect(forwardStatus('preprocessing', 'transcribing')).toBe('transcribing')
    expect(forwardStatus('transcribing', 'preprocessing')).toBe('transcribing')
    expect(forwardStatus('optimizing', 'completed')).toBe('completed')
    expect(forwardStatus('analyzingQueued', 'analyzing')).toBe('analyzing')
  })

  it('keeps progress counters in range and never divides', () => {
    expect(progressOf('diarizing')).toEqual({
      phase: 'diarizing',
      currentChunk: 0,
      totalChunks: 0,
      percent: null
    })
    expect(progressOf('transcribing', 5, 3, 140.4)).toEqual({
      phase: 'transcribing',
      currentChunk: 3,
      totalChunks: 3,
      percent: 100
    })
  })

  it('keeps analysis and transcription failures apart', () => {
    const storage = new JobFailure('storage_failed', 'Speicher')
    expect(failureOf('analysis', storage)).toEqual({ code: 'analysis_failed', message: 'Speicher' })
    expect(failureOf('transcription', storage)).toEqual({
      code: 'storage_failed',
      message: 'Speicher'
    })
    expect(failureOf('analysis', new JobFailure('unsupported_media', 'Kaputt')).code).toBe(
      'unsupported_media'
    )
    // Unexpected errors leave no internals in the message.
    expect(failureOf('transcription', new Error('postgres://secret'))).toEqual({
      code: 'internal',
      message: 'Die Datei konnte nicht verarbeitet werden.'
    })
  })
})
