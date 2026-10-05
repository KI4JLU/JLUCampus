import {
  firstSpeechModel,
  TRANSCRIPTION_DEFAULT_CONFIG,
  type TranscriptionModel
} from '@justcampus/shared'
import { describe, expect, it } from 'vitest'

import { withFetchedModels } from './model-lists'

describe('withFetchedModels', () => {
  it('keeps discovery’s speech classification and order, and the admin’s labels (C-3)', () => {
    const config = {
      ...TRANSCRIPTION_DEFAULT_CONFIG,
      asrModels: [{ id: 'whisper-1', label: 'Whisper (HRZ)' }],
      defaultAsrModel: null
    }
    const fetched: TranscriptionModel[] = [
      { id: 'campus-recognizer', label: 'campus-recognizer', speech: true },
      { id: 'whisper-1', label: 'whisper-1', speech: true }
    ]
    const { config: next } = withFetchedModels(config, 'asrModels', fetched)
    expect(next.asrModels).toEqual([
      { id: 'campus-recognizer', label: 'campus-recognizer', speech: true },
      { id: 'whisper-1', label: 'Whisper (HRZ)', speech: true }
    ])
    // The form shows the model the server will use: the first discovery classified.
    expect(firstSpeechModel(next.asrModels)?.id).toBe('campus-recognizer')
    // Chat lists carry no classification.
    const chat = withFetchedModels(config, 'llmModels', [{ id: 'chat', label: 'Chat' }])
    expect(chat.config.llmModels).toEqual([{ id: 'chat', label: 'Chat' }])
  })
})
