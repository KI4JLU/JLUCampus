import {
  TRANSCRIPTION_DEFAULT_CONFIG,
  TRANSCRIPTION_GROUP_FILES_MAX,
  type TranscriptionComponentConfig
} from '@justcampus/shared'
import { describe, expect, it } from 'vitest'

import {
  asrModel,
  capabilitiesOf,
  defaultRealtimeMode,
  llmModel,
  openaiRealtimeEndpoints,
  realtimeModes,
  type TranscriptionSecrets
} from './config.js'

const noSecrets: TranscriptionSecrets = {
  apiKey: null,
  diarizationApiKey: null,
  llmApiKey: null,
  openaiRealtimeApiKey: null
}

const configured: TranscriptionComponentConfig = {
  ...TRANSCRIPTION_DEFAULT_CONFIG,
  asrBaseUrl: 'http://localhost:9200/asr/v1',
  asrModels: [
    { id: 'jlu/whisper-1', label: 'Whisper' },
    { id: 'jlu/whisper-2', label: 'Whisper 2' }
  ],
  diarizationEnabled: true,
  diarizationUrl: 'http://localhost:9200/diarization/diarize',
  llmBaseUrl: 'http://localhost:9200/llm/v1',
  llmModels: [
    { id: 'small', label: 'Small' },
    { id: 'large', label: 'Large' }
  ],
  defaultSummaryModel: 'large',
  realtimeModes: ['onprem', 'openai'],
  onpremSignalingUrl: 'http://localhost:9200/realtime/onprem/signaling'
}

describe('model choice', () => {
  it('takes the listed default speech model, else the first', () => {
    expect(asrModel(configured)?.id).toBe('jlu/whisper-1')
    expect(asrModel({ ...configured, defaultAsrModel: 'jlu/whisper-2' })?.id).toBe('jlu/whisper-2')
    expect(asrModel({ ...configured, defaultAsrModel: 'gone' })?.id).toBe('jlu/whisper-1')
    expect(asrModel(TRANSCRIPTION_DEFAULT_CONFIG)).toBeNull()
  })

  it('never uses a chat model the admin did not list', () => {
    expect(llmModel(configured, 'summary')).toBe('large')
    expect(llmModel(configured, 'correction')).toBe('small')
    expect(llmModel(configured, 'summary', 'small')).toBe('small')
    expect(llmModel(configured, 'summary', 'gpt-5')).toBe('large')
    expect(llmModel({ ...configured, llmBaseUrl: null }, 'summary')).toBeNull()
  })
})

describe('live modes', () => {
  it('offers only modes that are set up', () => {
    expect(realtimeModes(configured, noSecrets)).toEqual(['onprem'])
    expect(realtimeModes(configured, { ...noSecrets, openaiRealtimeApiKey: 'sk' })).toEqual([
      'onprem',
      'openai'
    ])
    expect(realtimeModes({ ...configured, onpremSignalingUrl: null }, noSecrets)).toEqual([])
  })

  it('falls back to the first mode when the default is not offered', () => {
    expect(defaultRealtimeMode({ ...configured, defaultRealtimeMode: 'openai' }, ['onprem'])).toBe(
      'onprem'
    )
    expect(defaultRealtimeMode(configured, [])).toBeNull()
  })

  it('derives the OpenAI endpoints from the base URL', () => {
    expect(
      openaiRealtimeEndpoints({ ...configured, openaiRealtimeUrl: 'https://api.openai.com/v1/' })
    ).toEqual({
      clientSecretsUrl: 'https://api.openai.com/v1/realtime/client_secrets',
      callsUrl: 'https://api.openai.com/v1/realtime/calls'
    })
  })
})

describe('capabilitiesOf', () => {
  it('offers nothing for a fresh module', () => {
    const capabilities = capabilitiesOf(TRANSCRIPTION_DEFAULT_CONFIG, noSecrets, true)
    expect(capabilities).toMatchObject({
      batch: false,
      diarization: false,
      llmCorrection: false,
      summaries: false,
      realtimeModes: [],
      defaultRealtimeMode: null,
      defaults: { language: 'auto', speakerCount: 'auto', llmCorrection: false },
      retention: { transcriptHours: null, unsavedJobHours: 24 }
    })
  })

  it('names the file limit per transcript the save takes, unless the admin set a lower one', () => {
    expect(capabilitiesOf(TRANSCRIPTION_DEFAULT_CONFIG, noSecrets, true).limits).toMatchObject({
      maxFilesPerGroup: TRANSCRIPTION_GROUP_FILES_MAX
    })
    const limited = { ...TRANSCRIPTION_DEFAULT_CONFIG, maxFilesPerGroup: 5 }
    expect(capabilitiesOf(limited, noSecrets, true).limits.maxFilesPerGroup).toBe(5)
  })

  it('needs storage for uploads', () => {
    expect(capabilitiesOf(configured, noSecrets, false).batch).toBe(false)
    const capabilities = capabilitiesOf(configured, noSecrets, true)
    expect(capabilities).toMatchObject({
      batch: true,
      diarization: true,
      llmCorrection: true,
      summaries: true,
      speakerOptimization: true,
      asrModel: { id: 'jlu/whisper-1', label: 'Whisper' },
      defaultSummaryModel: 'large',
      defaults: { llmCorrection: true },
      realtimeModes: ['onprem'],
      defaultRealtimeMode: 'onprem'
    })
  })
})
