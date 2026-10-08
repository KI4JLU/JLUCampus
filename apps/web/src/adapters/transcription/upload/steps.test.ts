import { describe, expect, it } from 'vitest'
import type { QueueFile } from './queue'
import { fileSteps, type FileSteps } from './steps'

type Shown = Pick<QueueFile, 'phase' | 'status' | 'progress' | 'uploaded'>

const file = (change: Partial<Shown>): Shown => ({
  phase: 'idle',
  status: 'ready',
  progress: 0,
  uploaded: false,
  ...change
})

describe('file steps', () => {
  it('measures the upload and waits before it', () => {
    expect(fileSteps(file({}))).toEqual({
      active: 0,
      state: 'waiting',
      percent: null,
      detail: 'ready'
    })
    expect(fileSteps(file({ phase: 'uploading', status: 'creatingSession', progress: 2 }))).toEqual(
      { active: 0, state: 'running', percent: null, detail: 'creatingSession' }
    )
    expect(fileSteps(file({ phase: 'uploading', status: 'uploadingFile', progress: 26 }))).toEqual({
      active: 0,
      state: 'running',
      percent: 50,
      detail: null
    })
    expect(
      fileSteps(file({ phase: 'uploading', status: 'uploadingFile', progress: 50 }))?.percent
    ).toBe(100)
  })

  it('runs the speaker detection without a percentage', () => {
    expect(
      fileSteps(
        file({ phase: 'uploading', status: 'analyzingAudio', progress: 50, uploaded: true })
      )
    ).toEqual({ active: 1, state: 'running', percent: null, detail: 'analyzingAudio' })
    expect(
      fileSteps(file({ phase: 'analyzing', status: 'analyzingSpeakers', progress: 80 }))
    ).toEqual({ active: 1, state: 'running', percent: null, detail: null })
    expect(fileSteps(file({ phase: 'analyzing', status: 'waitingForAnalysis' }))?.detail).toBe(
      'waitingForAnalysis'
    )
    // A repeated analysis starts from the ready status; that is no word for it.
    expect(fileSteps(file({ phase: 'analyzing', status: 'readyForTranscription' }))?.detail).toBe(
      null
    )
  })

  it('waits for the start after the analysis', () => {
    expect(
      fileSteps(file({ phase: 'ready', status: 'readyForTranscription', progress: 100 }))
    ).toEqual({ active: 2, state: 'waiting', percent: null, detail: 'readyForTranscription' })
  })

  it('scales the recognition into the transcription step', () => {
    const transcribing = (status: QueueFile['status'], progress: number): FileSteps | null =>
      fileSteps(file({ phase: 'transcribing', status, progress, uploaded: true }))
    expect(transcribing('preprocessing', 20)).toEqual({
      active: 2,
      state: 'running',
      percent: null,
      detail: 'preprocessing'
    })
    expect(transcribing('preparing', 40)?.detail).toBe('preparing')
    expect(transcribing('inProgress', 40)).toEqual({
      active: 2,
      state: 'running',
      percent: null,
      detail: null
    })
    expect(transcribing('transcribing', 40)?.percent).toBe(0)
    // The server's 45 of its 90 % for the recognition.
    expect(transcribing('transcribing', 62.5)?.percent).toBe(50)
    expect(transcribing('transcribing', 85)?.percent).toBe(100)
    expect(transcribing('speakerAssignment', 95)).toEqual({
      active: 3,
      state: 'running',
      percent: null,
      detail: null
    })
  })

  it('fails in the step it was in', () => {
    expect(fileSteps(file({ phase: 'analysisFailed', status: 'failed' }))).toEqual({
      active: 0,
      state: 'error',
      percent: null,
      detail: null
    })
    expect(
      fileSteps(file({ phase: 'analysisFailed', status: 'failed', uploaded: true }))?.active
    ).toBe(1)
    expect(fileSteps(file({ phase: 'failed', status: 'failed' }))?.active).toBe(2)
    expect(fileSteps(file({ phase: 'failed', status: 'failed' }), 3)?.active).toBe(3)
    expect(fileSteps(file({ phase: 'failed', status: 'failed' }), 1)?.active).toBe(2)
  })

  it('ends once the file is completed', () => {
    expect(fileSteps(file({ phase: 'completed', status: 'transcriptionComplete' }))).toBeNull()
    expect(fileSteps(file({ phase: 'completed', status: 'readyFromCache' }))).toBeNull()
  })
})
