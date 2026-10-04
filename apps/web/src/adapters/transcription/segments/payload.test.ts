import { describe, expect, it } from 'vitest'
import { transcriptionTranscriptSchema } from '@justcampus/shared'
import { withParsedSegments } from './payload'

describe('withParsedSegments', () => {
  const segment = { id: 0, start: 0, end: 1, text: 'Hallo', speaker: 'Anna', redactions: [] }
  const detail = {
    id: '0b7c2a4e-6f4d-4b8e-9a51-1d1f1c3e5a77',
    title: 'T',
    subtitle: null,
    subtitleSource: null,
    language: 'de',
    duration: 1,
    originalFilename: null,
    createdAt: '2026-10-04T10:00:00.000Z',
    updatedAt: '2026-10-04T10:00:00.000Z',
    expiresAt: null,
    model: null,
    provider: null,
    fileSize: null,
    text: 'Hallo',
    words: [],
    sourceFiles: [],
    speakerColors: {},
    summaryTemplateId: null,
    revision: 1
  }

  it('lets a detail with segments as JSON text pass the contract like one with an array', () => {
    const asText = { ...detail, segments: JSON.stringify([segment]) }
    expect(transcriptionTranscriptSchema.safeParse(asText).success).toBe(false)
    const parsed = transcriptionTranscriptSchema.parse(withParsedSegments(asText))
    expect(parsed.segments).toEqual([segment])
    expect(
      transcriptionTranscriptSchema.parse(withParsedSegments({ ...detail, segments: [segment] }))
        .segments
    ).toEqual([segment])
  })

  it('leaves anything else to the contract', () => {
    expect(withParsedSegments({ segments: '{' })).toEqual({ segments: '{' })
    expect(withParsedSegments({ segments: '{"a":1}' })).toEqual({ segments: '{"a":1}' })
    expect(withParsedSegments(null)).toBeNull()
  })
})
