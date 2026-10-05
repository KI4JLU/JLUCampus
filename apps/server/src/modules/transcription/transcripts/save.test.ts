import {
  TRANSCRIPTION_DEFAULT_CONFIG,
  transcriptionTranscriptCreateSchema,
  type TranscriptionTranscriptCreate
} from '@justcampus/shared'
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'

import { ApiError } from '../../../api.js'
import { buildNewTranscript } from './save.js'
import type { GroupJob } from './store.js'

const first = '11111111-1111-4111-8111-111111111111'
const second = '22222222-2222-4222-8222-222222222222'

function job(id: string, overrides: Partial<GroupJob> = {}): GroupJob {
  return {
    id,
    filename: `${id.slice(0, 4)}.wav`,
    size: 1000,
    status: 'completed',
    transcriptId: null,
    result: null,
    ...overrides
  }
}

function input(
  overrides: Partial<TranscriptionTranscriptCreate> = {}
): z.output<typeof transcriptionTranscriptCreateSchema> {
  return transcriptionTranscriptCreateSchema.parse({
    idempotencyKey: '33333333-3333-4333-8333-333333333333',
    title: 'Gruppe',
    jobIds: [first, second],
    language: 'de',
    duration: 21,
    segments: [
      { id: 0, start: 0, end: 10, text: ' Guten Tag. ', speaker: 'Anna' },
      {
        id: 1,
        start: 11,
        end: 21,
        text: 'Hallo.',
        speaker: 'Ben',
        redactions: [{ start: 0, end: 5 }]
      }
    ],
    sourceFiles: [
      { jobId: first, name: 'a.wav', size: 1000, duration: 10.5, startTime: 0, endTime: 10.5 },
      { jobId: second, name: 'b.wav', size: 2000, duration: 10.5, startTime: 10.5, endTime: 21 }
    ],
    speakerColors: { Anna: { colorId: 3, speakerIndex: 0 } },
    ...overrides
  })
}

const context = { config: TRANSCRIPTION_DEFAULT_CONFIG, userLocale: 'en', expiresAt: null }

function refusal(run: () => unknown): { status: number; code: string } {
  try {
    run()
  } catch (error) {
    if (error instanceof ApiError) return { status: error.status, code: error.code }
    throw error
  }
  throw new Error('Expected a refusal')
}

describe('buildNewTranscript', () => {
  it('takes the group in queue order with its segments, colours and source ranges', () => {
    const values = buildNewTranscript(
      input(),
      [job(second, { size: 2000, filename: 'b.wav' }), job(first, { filename: 'a.wav' })],
      context
    )
    expect(values).toMatchObject({
      title: 'Gruppe',
      language: 'de',
      duration: 21,
      originalFilename: 'a.wav',
      fileSize: 3000,
      text: 'Guten Tag. Hallo.',
      userLocale: 'en',
      speakerColors: { Anna: { colorId: 3, speakerIndex: 0 } }
    })
    expect(values.segments[1]!.redactions).toEqual([{ start: 0, end: 5 }])
    expect(values.sourceFiles.map((file) => [file.startTime, file.endTime])).toEqual([
      [0, 10.5],
      [10.5, 21]
    ])
  })

  it('names the model and provider of the results, else of the settings', () => {
    const config = {
      ...TRANSCRIPTION_DEFAULT_CONFIG,
      asrModels: [{ id: 'jlu/whisper-1', label: 'Whisper' }],
      providerName: 'KI@JLU'
    }
    expect(
      buildNewTranscript(input(), [job(first), job(second)], { ...context, config })
    ).toMatchObject({
      model: 'jlu/whisper-1',
      provider: 'KI@JLU'
    })
    const result = {
      text: '',
      language: 'de',
      duration: 1,
      segments: [],
      words: [],
      model: 'other-model',
      provider: 'Other'
    }
    expect(
      buildNewTranscript(input(), [job(first, { result }), job(second)], { ...context, config })
    ).toMatchObject({ model: 'other-model', provider: 'Other' })
  })

  it('refuses a job of another user or a missing one as not found', () => {
    expect(refusal(() => buildNewTranscript(input(), [job(first)], context))).toEqual({
      status: 404,
      code: 'not_found'
    })
  })

  it('refuses unfinished and already saved jobs', () => {
    expect(
      refusal(() =>
        buildNewTranscript(input(), [job(first), job(second, { status: 'transcribing' })], context)
      )
    ).toEqual({ status: 409, code: 'conflict' })
    expect(
      refusal(() =>
        buildNewTranscript(
          input(),
          [job(first), job(second, { transcriptId: '44444444-4444-4444-8444-444444444444' })],
          context
        )
      )
    ).toEqual({ status: 409, code: 'conflict' })
  })

  it('refuses repeated jobs and source files of other jobs', () => {
    expect(
      refusal(() => buildNewTranscript(input({ jobIds: [first, first] }), [job(first)], context))
    ).toEqual({ status: 400, code: 'validation' })
    expect(
      refusal(() =>
        buildNewTranscript(input({ jobIds: [first] }), [job(first), job(second)], context)
      )
    ).toEqual({ status: 400, code: 'validation' })
  })
})

describe('large groups (T-04, T-13)', () => {
  /** A group of `count` one-segment files, as the browser's merge sends it. */
  function largeGroup(count: number): { body: ReturnType<typeof input>; jobs: GroupJob[] } {
    const ids = Array.from(
      { length: count },
      (_, index) => `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`
    )
    const body = input({
      jobIds: ids,
      duration: count * 10,
      segments: ids.map((_, index) => ({
        id: index,
        start: index * 10,
        end: index * 10 + 9,
        text: `Datei ${index + 1}.`,
        speaker: 'Anna'
      })),
      sourceFiles: ids.map((jobId, index) => ({
        jobId,
        name: `${index}.wav`,
        size: 1000,
        duration: 10,
        startTime: index * 10,
        endTime: index * 10 + 10
      }))
    })
    return { body, jobs: ids.map((id) => job(id)) }
  }

  it('saves a group of 150 files without an admin limit, as kiChat has none', () => {
    const { body, jobs } = largeGroup(150)
    const values = buildNewTranscript(body, jobs, context)
    expect(values.sourceFiles).toHaveLength(150)
    expect(values.fileSize).toBe(150_000)
    expect(values.text).toContain('Datei 150.')
  })

  it('refuses a group above the admin’s limit', () => {
    const { body, jobs } = largeGroup(3)
    const config = { ...TRANSCRIPTION_DEFAULT_CONFIG, maxFilesPerGroup: 2 }
    expect(refusal(() => buildNewTranscript(body, jobs, { ...context, config }))).toEqual({
      status: 400,
      code: 'validation'
    })
    expect(
      buildNewTranscript(body, jobs, { ...context, config: { ...config, maxFilesPerGroup: 3 } })
    ).toBeTruthy()
  })
})
