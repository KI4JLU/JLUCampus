import { describe, expect, it } from 'vitest'
import {
  encodeWav,
  formatFileSize,
  recordingFilename,
  recordingUsername,
  type PcmSource
} from './wav'

function source(channels: number[][], sampleRate = 48_000): PcmSource {
  return {
    numberOfChannels: channels.length,
    sampleRate,
    length: channels[0]?.length ?? 0,
    getChannelData: (channel) => Float32Array.from(channels[channel] ?? [])
  }
}

function text(view: DataView, offset: number, length: number): string {
  return String.fromCharCode(...Array.from({ length }, (_, index) => view.getUint8(offset + index)))
}

describe('encodeWav', () => {
  it('writes a PCM16 RIFF header with the decoded sample rate and channel count', () => {
    const view = new DataView(
      encodeWav(
        source(
          [
            [0, 0.5, -0.5],
            [1, -1, 0]
          ],
          44_100
        )
      )
    )
    expect(text(view, 0, 4)).toBe('RIFF')
    expect(view.getUint32(4, true)).toBe(36 + 12)
    expect(text(view, 8, 4)).toBe('WAVE')
    expect(text(view, 12, 4)).toBe('fmt ')
    expect(view.getUint32(16, true)).toBe(16)
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(2)
    expect(view.getUint32(24, true)).toBe(44_100)
    expect(view.getUint32(28, true)).toBe(44_100 * 4)
    expect(view.getUint16(32, true)).toBe(4)
    expect(view.getUint16(34, true)).toBe(16)
    expect(text(view, 36, 4)).toBe('data')
    expect(view.getUint32(40, true)).toBe(12)
    expect(view.byteLength).toBe(44 + 12)
  })

  it('interleaves the channels and clamps the samples', () => {
    const view = new DataView(
      encodeWav(
        source([
          [0, 2],
          [-2, 0.5]
        ])
      )
    )
    expect(view.getInt16(44, true)).toBe(0)
    expect(view.getInt16(46, true)).toBe(-0x8000)
    expect(view.getInt16(48, true)).toBe(0x7fff)
    expect(view.getInt16(50, true)).toBe(Math.trunc(0.5 * 0x7fff))
  })

  it('encodes a mono recording without data', () => {
    const view = new DataView(encodeWav(source([[]], 16_000)))
    expect(view.byteLength).toBe(44)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(40, true)).toBe(0)
  })
})

describe('recordingFilename', () => {
  it('names a take <username>-YYYYMMDD-HHMMSS.wav in local time', () => {
    expect(recordingFilename('max.spaeth', new Date(2026, 9, 4, 9, 5, 7))).toBe(
      'max.spaeth-20261004-090507.wav'
    )
    expect(recordingFilename('user', new Date(2027, 0, 31, 23, 59, 59))).toBe(
      'user-20270131-235959.wav'
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
