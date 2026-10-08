import { transcriptionDispatchSchema } from '@justcampus/shared'
import { describe, expect, it } from 'vitest'

import { cleanFilename, dispatchIssues, uploadContentType } from './validate.js'

const job = { speakers: [{ id: 'SPEAKER_00' }, { id: 'SPEAKER_01' }], duration: 11.24 }

function dispatch(
  input: Record<string, unknown>
): ReturnType<typeof transcriptionDispatchSchema.parse> {
  return transcriptionDispatchSchema.parse({
    mapping: {},
    snippets: [],
    speakerCount: 'auto',
    llmCorrection: false,
    ...input
  })
}

describe('dispatchIssues', () => {
  it('accepts kiChat’s dispatch of the fixture', () => {
    const input = dispatch({
      mapping: { SPEAKER_00: 'Test speaker' },
      snippets: [{ id: 'SPEAKER_00', name: 'Test speaker', start: 0.03096875, end: 5.03096875 }],
      llmCorrection: true
    })
    expect(dispatchIssues(input, job, { correctionAvailable: true })).toEqual([])
  })

  it('accepts voices added by hand', () => {
    const input = dispatch({
      mapping: { SPEAKER_00: 'Anna', MANUAL_0: 'Carla' },
      snippets: [{ id: 'MANUAL_0', name: 'Carla', start: 6, end: 8 }],
      colors: { MANUAL_0: 3 }
    })
    expect(dispatchIssues(input, job, { correctionAvailable: false })).toEqual([])
  })

  it('refuses windows outside the audio, unknown voices and unavailable correction', () => {
    const input = dispatch({
      mapping: { SPEAKER_07: 'Ghost' },
      snippets: [
        { id: 'SPEAKER_00', name: 'Anna', start: 11.5, end: 12 },
        { id: 'SPEAKER_01', name: 'Ben', start: 10, end: 11.6 },
        { id: 'SPEAKER_01', name: 'Ben', start: 10, end: 13 }
      ],
      colors: { SPEAKER_09: 2 },
      llmCorrection: true
    })
    expect(dispatchIssues(input, job, { correctionAvailable: false })).toEqual([
      { path: ['snippets', 0], message: 'The window lies outside the audio' },
      { path: ['snippets', 2], message: 'The window lies outside the audio' },
      { path: ['mapping', 'SPEAKER_07'], message: 'Unknown speaker' },
      { path: ['colors', 'SPEAKER_09'], message: 'Unknown speaker' },
      { path: ['llmCorrection'], message: 'The correction is not set up' }
    ])
  })

  it('does not bound windows before the duration is known', () => {
    const input = dispatch({ snippets: [{ id: 'X', name: 'X', start: 500, end: 600 }] })
    expect(
      dispatchIssues(input, { speakers: [], duration: null }, { correctionAvailable: false })
    ).toEqual([])
  })
})

describe('upload helpers', () => {
  it('keeps only the file’s own name', () => {
    expect(cleanFilename('C:\\Users\\a\\Aufnahme 1.wav')).toBe('Aufnahme 1.wav')
    expect(cleanFilename('/tmp/x/../talk.mp3 ')).toBe('talk.mp3')
  })

  it('binds the upload to the browser’s type, else the extension’s', () => {
    expect(uploadContentType('a.wav', 'audio/wav')).toBe('audio/wav')
    expect(uploadContentType('a.WAV', '')).toBe('audio/wav')
    expect(uploadContentType('a.m4a', '')).toBe('audio/mp4')
    expect(uploadContentType('a.mp4', 'video/mp4')).toBe('video/mp4')
    expect(uploadContentType('recording', 'audio/webm;codecs=opus')).toBe(
      'application/octet-stream'
    )
    expect(uploadContentType('take.ogg', 'bad type\r\nX: y')).toBe('audio/ogg')
    expect(uploadContentType('meeting.webm', '')).toBe('audio/webm')
  })
})
