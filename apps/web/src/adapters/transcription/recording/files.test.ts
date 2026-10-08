import { describe, expect, it } from 'vitest'
import {
  formatFileSize,
  recorderMimeType,
  recordingFilename,
  recordingFormat,
  recordingUsername
} from './files'

describe('recorderMimeType', () => {
  it('prefers Opus in WebM, then any WebM, else the browser default', () => {
    expect(recorderMimeType(() => true)).toBe('audio/webm;codecs=opus')
    expect(recorderMimeType((type) => type === 'audio/webm')).toBe('audio/webm')
    expect(recorderMimeType(() => false)).toBeUndefined()
  })
})

describe('recordingFormat', () => {
  it('names and types a take after what the recorder wrote', () => {
    expect(recordingFormat('audio/webm;codecs=opus')).toEqual({
      extension: 'webm',
      type: 'audio/webm'
    })
    expect(recordingFormat('video/webm')).toEqual({ extension: 'webm', type: 'audio/webm' })
    // Safari.
    expect(recordingFormat('audio/mp4')).toEqual({ extension: 'm4a', type: 'audio/mp4' })
    expect(recordingFormat('audio/mp4;codecs=mp4a.40.2')).toEqual({
      extension: 'm4a',
      type: 'audio/mp4'
    })
    // Firefox's own default.
    expect(recordingFormat('audio/ogg;codecs=opus')).toEqual({
      extension: 'ogg',
      type: 'audio/ogg'
    })
  })

  it('refuses an unnamed type and others the upload does not take', () => {
    expect(recordingFormat('')).toBeNull()
    expect(recordingFormat('audio/x-matroska')).toBeNull()
    expect(recordingFormat('audio/wav')).toBeNull()
  })
})

describe('recordingFilename', () => {
  it('names a take <username>-YYYYMMDD-HHMMSS.<extension> in local time', () => {
    expect(recordingFilename('max.spaeth', new Date(2026, 9, 4, 9, 5, 7), 'webm')).toBe(
      'max.spaeth-20261004-090507.webm'
    )
    expect(recordingFilename('user', new Date(2027, 0, 31, 23, 59, 59), 'm4a')).toBe(
      'user-20270131-235959.m4a'
    )
  })
})

describe('recordingUsername', () => {
  it('takes the local part of the e-mail address', () => {
    expect(recordingUsername({ email: 'max.spaeth@uni-giessen.de', name: 'Max Späth' })).toBe(
      'max.spaeth'
    )
  })

  it('falls back to the display name without umlauts and spaces', () => {
    expect(recordingUsername({ email: '', name: 'Jörg Müller' })).toBe('Jorg-Muller')
  })

  it('is user when nothing usable is known', () => {
    expect(recordingUsername(null)).toBe('user')
    expect(recordingUsername({ email: '@x', name: '???' })).toBe('user')
  })
})

describe('formatFileSize', () => {
  it('writes megabytes with one decimal and kilobytes rounded up', () => {
    expect(formatFileSize(0)).toBe('0 KB')
    expect(formatFileSize(1500)).toBe('2 KB')
    expect(formatFileSize(5 * 1024 * 1024 + 100_000)).toBe('5.1 MB')
  })
})
