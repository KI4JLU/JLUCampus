import { describe, expect, it } from 'vitest'
import { TRANSCRIPTION_MAX_FILE_BYTES } from '@justcampus/shared'
import { limitMegabytes, partitionFiles } from './validation'

/** A file that claims a size without holding the bytes. */
function fake(name: string, type: string, size: number): File {
  const file = new File([], name, { type })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

describe('partitionFiles (T-04)', () => {
  it('takes a supported type or extension, case-insensitively', () => {
    const { accepted, rejected } = partitionFiles([
      fake('talk.MP3', '', 1),
      fake('no-extension', 'audio/ogg', 1),
      fake('clip.mp4', '', 1),
      fake('notes.txt', 'text/plain', 22),
      fake('meeting.webm', 'audio/webm', 1)
    ])
    expect(accepted.map((file) => file.name)).toEqual([
      'talk.MP3',
      'no-extension',
      'clip.mp4',
      'meeting.webm'
    ])
    expect(rejected.map(({ file, reason }) => [file.name, reason])).toEqual([
      ['notes.txt', 'unsupported']
    ])
  })

  it('accepts exactly 500 MiB and refuses one byte more', () => {
    const { accepted, rejected } = partitionFiles([
      fake('limit.wav', 'audio/wav', TRANSCRIPTION_MAX_FILE_BYTES),
      fake('over.wav', 'audio/wav', 524_288_001)
    ])
    expect(accepted.map((file) => file.name)).toEqual(['limit.wav'])
    expect(rejected).toEqual([{ file: expect.any(File), reason: 'tooLarge' }])
    expect(rejected[0]?.file.name).toBe('over.wav')
  })

  it('follows a limit the admin changed', () => {
    expect(partitionFiles([fake('a.wav', '', 2 * 1024 * 1024)], 1024 * 1024).rejected).toHaveLength(
      1
    )
    expect(limitMegabytes(TRANSCRIPTION_MAX_FILE_BYTES)).toBe(500)
  })
})
