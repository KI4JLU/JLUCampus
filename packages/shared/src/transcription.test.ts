import { describe, expect, it } from 'vitest'
import {
  adminComponentSchema,
  API,
  checkTranscriptionFile,
  COMPONENT_SECRETS,
  componentInputSchema,
  defaultSpeakerColorId,
  fillTemplatePlaceholders,
  isActiveJobStatus,
  isTranscriptionLiveErrorCode,
  isSingletonType,
  isTerminalJobStatus,
  progressPercent,
  TRANSCRIPT_PRESETS,
  TRANSCRIPTION_API,
  TRANSCRIPTION_AUTO_SPEAKER_LABEL,
  TRANSCRIPTION_BUILTIN_TEMPLATES,
  TRANSCRIPTION_DEFAULT_CONFIG,
  TRANSCRIPTION_DEFAULT_TEMPLATE_ID,
  TRANSCRIPTION_EXTENSIONS,
  TRANSCRIPTION_FILE_ACCEPT,
  TRANSCRIPTION_GROUP_FILES_MAX,
  TRANSCRIPTION_LIVE_UNAVAILABLE_CODES,
  TRANSCRIPTION_MAX_FILE_BYTES,
  TRANSCRIPTION_MIME_TYPES,
  TRANSCRIPTION_SPEAKER_COLORS,
  transcriptionComponentConfigSchema,
  transcriptionDispatchSchema,
  transcriptionJobCreateSchema,
  transcriptionRealtimeConfigSchema,
  transcriptionSegmentSchema,
  transcriptionSummaryRequestSchema,
  transcriptionTemplateInputSchema,
  transcriptionTemplateSchema,
  transcriptionTranscriptCreateSchema,
  transcriptionTranscriptPatchSchema,
  transcriptionUrls,
  widgetDefinition
} from './index'

const file = (
  name: string,
  size: number,
  type = ''
): { name: string; type: string; size: number } => ({
  name,
  type,
  size
})

describe('TRANSCRIPTION_FILE_ACCEPT', () => {
  it('offers exactly the extensions and MIME types the check takes', () => {
    expect(TRANSCRIPTION_FILE_ACCEPT.split(',')).toEqual([
      ...TRANSCRIPTION_EXTENSIONS.map((extension) => `.${extension}`),
      ...TRANSCRIPTION_MIME_TYPES
    ])
    expect(TRANSCRIPTION_FILE_ACCEPT).toBe(
      '.mp3,.wav,.m4a,.mp4,.ogg,audio/mpeg,audio/mp3,audio/wav,audio/m4a,audio/ogg,video/mp4'
    )
  })
})

describe('checkTranscriptionFile', () => {
  it('takes the five extensions in any case, or a supported MIME type', () => {
    for (const name of ['a.mp3', 'b.WAV', 'c.m4a', 'd.mp4', 'e.Ogg']) {
      expect(checkTranscriptionFile(file(name, 1))).toBe('ok')
    }
    expect(checkTranscriptionFile(file('recording', 1, 'audio/mpeg'))).toBe('ok')
    expect(checkTranscriptionFile(file('clip', 1, 'video/mp4'))).toBe('ok')
  })

  it('refuses other files before their size', () => {
    expect(checkTranscriptionFile(file('notes.txt', 22, 'text/plain'))).toBe('unsupported')
    expect(checkTranscriptionFile(file('mp3', 1))).toBe('unsupported')
    expect(checkTranscriptionFile(file('notes.txt', TRANSCRIPTION_MAX_FILE_BYTES + 1))).toBe(
      'unsupported'
    )
  })

  it('takes exactly 500 MiB and refuses one byte more (T-04)', () => {
    expect(checkTranscriptionFile(file('a.wav', 524_288_000))).toBe('ok')
    expect(checkTranscriptionFile(file('a.wav', 524_288_001))).toBe('tooLarge')
    expect(checkTranscriptionFile(file('a.wav', 2048), 1024)).toBe('tooLarge')
  })
})

describe('module registration', () => {
  it('is a singleton with four secrets and two widgets', () => {
    expect(isSingletonType('transcription')).toBe(true)
    expect(COMPONENT_SECRETS.transcription).toEqual([
      'apiKey',
      'diarizationApiKey',
      'llmApiKey',
      'openaiRealtimeApiKey'
    ])
    expect(widgetDefinition('transcription', 'quick')).toEqual({ minW: 2, minH: 2 })
    expect(widgetDefinition('transcription', 'recent')).toEqual({ minW: 3, minH: 4 })
    expect(API.module('transcription')).toBe('/api/modules/transcription')
    expect(TRANSCRIPTION_API.jobs.startsWith(API.module('transcription'))).toBe(true)
    expect(TRANSCRIPTION_API.adminModels.startsWith(API.adminModule('transcription'))).toBe(true)
  })

  it('parses an empty stored config to the defaults', () => {
    const config = transcriptionComponentConfigSchema.parse({})
    expect(config).toEqual(TRANSCRIPTION_DEFAULT_CONFIG)
    expect(config).toMatchObject({
      asrBaseUrl: 'https://api.hrz.uni-giessen.de/v1',
      asrModels: [],
      defaultAsrModel: 'jlu/whisper-1',
      asrConcurrency: 3,
      diarizationEnabled: false,
      diarizationUrl: null,
      diarizationModel: 'pyannote/speaker-diarization-community-1',
      defaultLanguage: 'auto',
      defaultSpeakerCount: 'auto',
      defaultLlmCorrection: true,
      maxFileBytes: TRANSCRIPTION_MAX_FILE_BYTES,
      unsavedJobRetentionHours: 24,
      transcriptRetentionHours: null,
      realtimeModes: [],
      openaiRealtimeUrl: 'https://api.openai.com/v1'
    })
  })

  it('accepts the mock server on localhost and refuses plain http elsewhere', () => {
    expect(
      transcriptionComponentConfigSchema.safeParse({ asrBaseUrl: 'http://localhost:9200/asr/v1' })
        .success
    ).toBe(true)
    expect(
      transcriptionComponentConfigSchema.safeParse({ asrBaseUrl: 'http://asr.example.org/v1' })
        .success
    ).toBe(false)
    // Several speech workers, comma-separated as kiChat's `base_url`; each must be a valid URL.
    expect(
      transcriptionComponentConfigSchema.safeParse({
        asrBaseUrl: 'https://w1.example.org/v1, https://w2.example.org/v1'
      }).success
    ).toBe(true)
    expect(
      transcriptionComponentConfigSchema.safeParse({
        asrBaseUrl: 'https://w1.example.org/v1, http://w2.example.org/v1'
      }).success
    ).toBe(false)
    expect(transcriptionUrls(' https://a.test/v1 ,, https://b.test/v1')).toEqual([
      'https://a.test/v1',
      'https://b.test/v1'
    ])
    expect(
      transcriptionComponentConfigSchema.safeParse({ realtimeModes: ['onprem', 'onprem'] }).success
    ).toBe(false)
  })

  it('takes the live gateway and model, and drops the WebRTC settings of older releases', () => {
    // A config saved by the WebRTC releases, with the bridge, ICE servers and TURN sign-in.
    const config = transcriptionComponentConfigSchema.parse({
      realtimeModes: ['onprem'],
      onpremSignalingUrl: 'http://host.docker.internal:8089',
      realtimeIceServers: [{ urls: ['turn:turn.example.org:3478'] }],
      realtimeTurnAuth: 'ephemeral',
      realtimeTurnCredentialSeconds: 3600
    })
    expect(config).toMatchObject({
      realtimeModes: ['onprem'],
      onpremGatewayUrl: null,
      onpremRealtimeModel: 'voxtral-mini-realtime'
    })
    for (const key of [
      'onpremSignalingUrl',
      'realtimeIceServers',
      'realtimeTurnAuth',
      'realtimeTurnCredentialSeconds'
    ]) {
      expect(config).not.toHaveProperty(key)
    }
    // The gateway is reached over the internet: https only, as every other upstream.
    expect(
      transcriptionComponentConfigSchema.safeParse({ onpremGatewayUrl: 'http://gw.example/v1' })
        .success
    ).toBe(false)
    // An older server's realtime config parses: on-prem counts as available.
    expect(
      transcriptionRealtimeConfigSchema.parse({
        modes: ['onprem'],
        defaultMode: 'onprem',
        iceServers: [],
        openaiModel: null
      }).onpremUnavailable
    ).toBeNull()
  })

  it('names a live error code for every unavailable reason', () => {
    for (const code of Object.values(TRANSCRIPTION_LIVE_UNAVAILABLE_CODES)) {
      expect(isTranscriptionLiveErrorCode(code)).toBe(true)
    }
    expect(isTranscriptionLiveErrorCode('the gateway said something')).toBe(false)
  })

  it('takes secret changes in the admin input and reports them as booleans', () => {
    const base = {
      type: 'transcription',
      name: 'Transkription',
      icon: 'mic',
      iconUrl: null,
      enabled: false,
      config: {}
    }
    expect(
      componentInputSchema.safeParse({ ...base, secrets: { apiKey: 'k', llmApiKey: null } }).success
    ).toBe(true)
    expect(componentInputSchema.safeParse({ ...base, secrets: { deeplApiKey: 'k' } }).success).toBe(
      false
    )
    const admin = adminComponentSchema.parse({
      ...base,
      id: '11111111-1111-4111-8111-111111111111',
      sortOrder: 3,
      createdAt: '2026-10-04T08:00:00.000Z',
      updatedAt: '2026-10-04T08:00:00.000Z',
      secrets: {
        apiKey: true,
        diarizationApiKey: false,
        llmApiKey: false,
        openaiRealtimeApiKey: false
      }
    })
    expect(admin.type === 'transcription' && admin.config.chunkSeconds).toBe(600)
  })
})

describe('jobs', () => {
  it('creates a job with kiChat defaults and refuses unsupported names', () => {
    const job = transcriptionJobCreateSchema.parse({ filename: 'campus-test.wav', size: 495_752 })
    expect(job).toMatchObject({
      language: 'auto',
      speakerCount: 'auto',
      llmCorrection: true,
      groupId: null,
      groupOrder: 0,
      mimeType: ''
    })
    expect(
      transcriptionJobCreateSchema.safeParse({ filename: 'notes.txt', size: 22 }).success
    ).toBe(false)
  })

  it('takes the observed dispatch and refuses an empty window', () => {
    const dispatch = {
      mapping: { SPEAKER_00: 'Test speaker' },
      snippets: [{ id: 'SPEAKER_00', name: 'Test speaker', start: 0.03096875, end: 5.03096875 }],
      speakerCount: 'auto',
      llmCorrection: true
    }
    expect(transcriptionDispatchSchema.parse(dispatch).colors).toEqual({})
    expect(
      transcriptionDispatchSchema.safeParse({
        ...dispatch,
        snippets: [{ id: 'SPEAKER_00', name: 'Test speaker', start: 2, end: 2 }]
      }).success
    ).toBe(false)
  })

  it('saves groups far larger than usual: no file limit unless the admin sets one (T-04)', () => {
    expect(TRANSCRIPTION_DEFAULT_CONFIG.maxFilesPerGroup).toBeNull()
    expect(transcriptionComponentConfigSchema.safeParse({ maxFilesPerGroup: 500 }).success).toBe(
      true
    )
    const ids = Array.from(
      { length: 150 },
      (_, index) => `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`
    )
    const group = {
      idempotencyKey: '33333333-3333-4333-8333-333333333333',
      title: 'Transkript 1',
      jobIds: ids,
      language: 'de',
      duration: 1500,
      segments: [],
      sourceFiles: ids.map((jobId, index) => ({
        jobId,
        name: `${index}.wav`,
        size: 1,
        duration: 10,
        startTime: index * 10,
        endTime: index * 10 + 10
      }))
    }
    expect(transcriptionTranscriptCreateSchema.safeParse(group).success).toBe(true)
    expect(
      transcriptionJobCreateSchema.safeParse({
        filename: 'a.wav',
        size: 1,
        groupOrder: TRANSCRIPTION_GROUP_FILES_MAX - 1
      }).success
    ).toBe(true)
  })

  it('tells active and terminal states apart', () => {
    expect(isActiveJobStatus('analyzingQueued')).toBe(true)
    expect(isActiveJobStatus('transcribing')).toBe(true)
    expect(isActiveJobStatus('analyzed')).toBe(false)
    expect(isActiveJobStatus('uploading')).toBe(false)
    expect(isTerminalJobStatus('failed')).toBe(true)
    expect(isTerminalJobStatus('analyzed')).toBe(false)
  })

  it('computes progress without dividing by zero chunks (T-11)', () => {
    const base = { phase: 'diarizing' as const, currentChunk: 0, totalChunks: 0, percent: null }
    expect(progressPercent(null)).toBeNull()
    expect(progressPercent(base)).toBeNull()
    expect(progressPercent({ ...base, currentChunk: 1, totalChunks: 4 })).toBe(25)
    expect(progressPercent({ ...base, percent: 60 })).toBe(60)
  })
})

describe('segments', () => {
  const segment = {
    id: 1,
    start: 0,
    end: 10.72,
    speaker: 'Test speaker',
    text: 'Guten Tag. Dies ist ein kurzer Test.',
    avgLogprob: -0.0568241,
    tokens: [1, 2, 3]
  }

  it('keeps decoder fields and defaults the redactions', () => {
    const parsed = transcriptionSegmentSchema.parse(segment)
    expect(parsed.redactions).toEqual([])
    expect(parsed.avgLogprob).toBe(-0.0568241)
    expect(parsed.tokens).toEqual([1, 2, 3])
  })

  it('refuses redactions outside the text and reversed times', () => {
    expect(
      transcriptionSegmentSchema.safeParse({ ...segment, redactions: [{ start: 0, end: 500 }] })
        .success
    ).toBe(false)
    expect(
      transcriptionSegmentSchema.safeParse({ ...segment, redactions: [{ start: 3, end: 3 }] })
        .success
    ).toBe(false)
    expect(transcriptionSegmentSchema.safeParse({ ...segment, start: 11 }).success).toBe(false)
  })

  it('needs a change besides the base revision in a patch', () => {
    expect(transcriptionTranscriptPatchSchema.safeParse({ baseRevision: 2 }).success).toBe(false)
    expect(
      transcriptionTranscriptPatchSchema.safeParse({ baseRevision: 2, title: 'Neu' }).success
    ).toBe(true)
  })
})

describe('formats and templates', () => {
  it('holds the preset truth table (T-44)', () => {
    expect(TRANSCRIPT_PRESETS.dialog_standard).toEqual({
      speakers: true,
      timestamps: true,
      avatars: true,
      bubbles: true,
      anonymize: false,
      order: 'chronological'
    })
    expect(TRANSCRIPT_PRESETS.zeitcodes).toMatchObject({ speakers: false, timestamps: true })
    expect(TRANSCRIPT_PRESETS.sprecher_gruppiert.order).toBe('speaker')
    expect(Object.values(TRANSCRIPT_PRESETS).every((preset) => !preset.anonymize)).toBe(true)
  })

  it('ships the five built-in templates as valid templates', () => {
    expect(TRANSCRIPTION_BUILTIN_TEMPLATES.map((template) => template.id)).toEqual([
      'focus-group',
      'interview',
      'meeting-protocol',
      'mein-interview-format',
      'legacy'
    ])
    expect(
      TRANSCRIPTION_BUILTIN_TEMPLATES.some(({ id }) => id === TRANSCRIPTION_DEFAULT_TEMPLATE_ID)
    ).toBe(true)
    for (const template of TRANSCRIPTION_BUILTIN_TEMPLATES) {
      const parsed = transcriptionTemplateSchema.safeParse({
        ...template,
        builtIn: true,
        version: 1,
        outputFormatHints: null,
        createdAt: null,
        updatedAt: null
      })
      expect(parsed.success).toBe(true)
    }
  })

  it('needs a name and at least one block to save a template', () => {
    const structure = [{ type: 'divider' }]
    expect(
      transcriptionTemplateInputSchema.safeParse({ id: null, name: ' ', structure }).success
    ).toBe(false)
    expect(
      transcriptionTemplateInputSchema.safeParse({ id: null, name: 'A', structure: [] }).success
    ).toBe(false)
    expect(
      transcriptionTemplateInputSchema.safeParse({
        id: null,
        name: 'A',
        structure: [{ type: 'heading', level: 4, text: 'x' }]
      }).success
    ).toBe(false)
  })

  it('fills placeholders and their German aliases (T-52)', () => {
    expect(
      fillTemplatePlaceholders('{{title}} · {{datum}} · {{teilnehmer}} · {{duration}}', {
        title: 'Test',
        date: '04.10.2026',
        participants: 'A, B',
        duration: '1 Min'
      })
    ).toBe('Test · 04.10.2026 · A, B · 1 Min')
  })

  it('needs a transcript or a text to summarise', () => {
    expect(transcriptionSummaryRequestSchema.safeParse({ templateId: 'legacy' }).success).toBe(
      false
    )
    expect(
      transcriptionSummaryRequestSchema.safeParse({ templateId: 'legacy', transcriptText: 'Hallo' })
        .success
    ).toBe(true)
  })
})

describe('speakers', () => {
  it('cycles through ten colours by order of appearance', () => {
    expect(defaultSpeakerColorId(0)).toBe(1)
    expect(defaultSpeakerColorId(9)).toBe(10)
    expect(defaultSpeakerColorId(10)).toBe(1)
    expect(Object.keys(TRANSCRIPTION_SPEAKER_COLORS)).toHaveLength(10)
  })

  it('recognises automatic voice labels in either language', () => {
    for (const label of ['Stimme 1', 'Voice 2', 'Sprecherin 3', 'SPEAKER', 'Speaker 12']) {
      expect(TRANSCRIPTION_AUTO_SPEAKER_LABEL.test(label)).toBe(true)
    }
    expect(TRANSCRIPTION_AUTO_SPEAKER_LABEL.test('Test speaker')).toBe(false)
  })
})
