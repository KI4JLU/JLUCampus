import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { knownSpeakers, REFERENCE_MAX_SECONDS, referenceWindows, wavHeader } from './references.js'

let directory: string
let wav: string
/** Four seconds of 16 kHz mono where every sample holds its second (0, 1, 2, 3). */
const RATE = 16_000

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'transcription-references-'))
  wav = join(directory, 'normalized.wav')
  const data = Buffer.alloc(4 * RATE * 2)
  for (let sample = 0; sample < 4 * RATE; sample++) {
    data.writeInt16LE(Math.floor(sample / RATE), sample * 2)
  }
  await writeFile(wav, Buffer.concat([wavHeader(data.length, RATE, 1), data]))
})

afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

function decode(reference: string): { rate: number; seconds: number[] } {
  const bytes = Buffer.from(reference.replace(/^data:audio\/wav;base64,/, ''), 'base64')
  const data = bytes.subarray(44)
  const seconds = new Set<number>()
  for (let offset = 0; offset < data.length; offset += 2) seconds.add(data.readInt16LE(offset))
  return { rate: bytes.readUInt32LE(24), seconds: [...seconds] }
}

describe('known speaker references', () => {
  it('groups the windows by name in first-seen order, within the media and the budget', () => {
    expect(
      referenceWindows(
        [
          { id: 'SPEAKER_01', name: 'Ben', start: 2, end: 3 },
          { id: 'SPEAKER_00', name: 'Anna', start: 1, end: 1.5 },
          { id: 'SPEAKER_02', name: 'Anna', start: 0, end: 0.5 },
          { id: 'MANUAL_0', name: 'Carla', start: 9, end: 12 },
          { id: 'SPEAKER_03', name: ' ', start: 0, end: 1 }
        ],
        4
      )
    ).toEqual([
      { name: 'Ben', windows: [{ start: 2, end: 3 }] },
      {
        name: 'Anna',
        windows: [
          { start: 0, end: 0.5 },
          { start: 1, end: 1.5 }
        ]
      }
    ])
    const long = referenceWindows(
      Array.from({ length: 5 }, (_, index) => ({
        id: 'SPEAKER_00',
        name: 'Anna',
        start: index * 10,
        end: index * 10 + 5
      })),
      null
    )
    expect(long[0]!.windows).toHaveLength(REFERENCE_MAX_SECONDS / 5)
  })

  it('cuts the windows out of the normalised WAV as a data URI', async () => {
    const speakers = await knownSpeakers(
      wav,
      [
        { id: 'SPEAKER_00', name: 'Anna', start: 0.5, end: 0.75 },
        { id: 'SPEAKER_00', name: 'Anna', start: 2.25, end: 2.5 },
        { id: 'SPEAKER_01', name: 'Ben', start: 3.5, end: 9 }
      ],
      4
    )
    expect(speakers.map((speaker) => speaker.name)).toEqual(['Anna', 'Ben'])
    expect(speakers[0]!.reference.startsWith('data:audio/wav;base64,UklGR')).toBe(true)
    const anna = decode(speakers[0]!.reference)
    expect(anna.rate).toBe(RATE)
    expect(anna.seconds).toEqual([0, 2])
    expect(Buffer.from(speakers[0]!.reference.split(',')[1]!, 'base64').length).toBe(
      44 + 0.5 * RATE * 2
    )
    expect(decode(speakers[1]!.reference).seconds).toEqual([3])
  })
})
