import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'

import {
  TRANSCRIPTION_DEFAULT_CONFIG,
  TRANSCRIPTION_SEGMENTS_MAX,
  TRANSCRIPTION_WORDS_MAX,
  transcriptionJobPeaksSchema,
  type TranscriptionComponentConfig,
  type TranscriptionSnippet
} from '@justcampus/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { TranscriptionStorage } from '../storage.js'
import { cutAudio, MediaToolError, normalizeAudio, probeMedia } from './media.js'
import {
  asrCacheKey,
  checkResultSize,
  runAnalysis,
  runTranscription,
  turnsKey,
  type JobRun
} from './pipeline.js'
import type { JobRow } from './rows.js'
import { JobFailure } from './state.js'

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0

function ffmpeg(...args: string[]): void {
  const result = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args])
  if (result.status !== 0) throw new Error(String(result.stderr))
}

/** Object storage in memory, with the methods the pipeline uses. */
class MemoryStorage {
  readonly objects = new Map<string, Buffer>()

  private missing(key: string): Error {
    return Object.assign(new Error(`No such key ${key}`), { name: 'NoSuchKey' })
  }

  async downloadToFile(key: string, path: string): Promise<void> {
    const body = this.objects.get(key)
    if (!body) throw this.missing(key)
    await writeFile(path, body)
  }

  async uploadFile(key: string, path: string): Promise<void> {
    this.objects.set(key, await readFile(path))
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    this.objects.set(key, Buffer.from(body))
  }

  async get(key: string): Promise<Readable> {
    const body = this.objects.get(key)
    if (!body) throw this.missing(key)
    return Readable.from([body])
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key)
  }

  async deletePrefix(prefix: string): Promise<number> {
    let deleted = 0
    for (const key of [...this.objects.keys()]) {
      if (key.startsWith(prefix)) {
        this.objects.delete(key)
        deleted++
      }
    }
    return deleted
  }

  keys(): string[] {
    return [...this.objects.keys()].sort()
  }
}

const componentId = '00000000-0000-4000-8000-000000000001'

function jobRow(id: string, changes: Partial<JobRow> = {}): JobRow {
  const now = new Date()
  return {
    id,
    componentId,
    userId: 'user',
    groupId: null,
    groupOrder: 0,
    filename: 'meeting.wav',
    mimeType: 'audio/wav',
    size: 1,
    duration: null,
    objectKey: `transcription/${componentId}/jobs/${id}/source`,
    normalizedKey: null,
    status: 'analyzing',
    settings: { language: 'auto', speakerCount: 'auto', llmCorrection: false },
    speakers: [],
    mapping: {},
    snippets: [],
    colors: {},
    progress: null,
    result: null,
    error: null,
    upstreamJobId: null,
    transcriptId: null,
    attempts: 1,
    claimedAt: now,
    heartbeatAt: now,
    cancelRequestedAt: null,
    uploadedAt: now,
    completedAt: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: null,
    ...changes
  }
}

describe.skipIf(!hasFfmpeg)('media and pipeline with ffmpeg and the mock upstreams', () => {
  let directory: string
  let mock: Server
  let helper: Server
  let mockUrl: string
  let helperUrl: string
  const statuses: string[] = []

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'transcription-pipeline-'))
    // Twenty seconds of "speech" as 44.1 kHz stereo WAV, and five seconds of video with sound.
    // Noise, not a tone: the diarisation mock finds the voices' references in it by their samples.
    ffmpeg(
      '-f',
      'lavfi',
      '-i',
      'anoisesrc=duration=20:color=pink:amplitude=0.3:seed=7',
      '-ac',
      '2',
      '-ar',
      '44100',
      join(directory, 'talk.wav')
    )
    ffmpeg(
      '-f',
      'lavfi',
      '-i',
      'color=size=64x64:duration=5',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=500:duration=5',
      '-shortest',
      '-c:v',
      'mpeg4',
      '-c:a',
      'aac',
      join(directory, 'clip.mp4')
    )
    await writeFile(join(directory, 'invalid.wav'), 'RIFF not really')

    const mockPath = resolve(
      import.meta.dirname,
      '../../../../../../infra/transcription-mock/server.mjs'
    )
    const { startMock } = (await import(mockPath)) as {
      startMock: (port: number) => Promise<Server>
    }
    mock = await startMock(0)
    mockUrl = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`

    // A chat endpoint that corrects "zehn Uhr" in kiChat's answer format, a diariser answering
    // kiChat's 415, and a server without diarisation (the HRZ gateway's 404).
    helper = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        if (request.url?.startsWith('/d415/')) {
          response.writeHead(415).end()
          return
        }
        if (request.url?.startsWith('/none/')) {
          response.writeHead(404, { 'Content-Type': 'application/json' })
          response.end('{"detail":"Not Found"}')
          return
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          messages: Array<{ content: string }>
        }
        const transcript = body.messages[1]!.content.split('Hier ist das Transkript:\n')[1]!
        const corrections = [...transcript.matchAll(/^Segment \[(\d+)\] \((.*?)\): (.*)$/gm)].map(
          ([, index, speaker, text]) => ({
            original_index: Number(index),
            speaker,
            text: text!.replace('zehn', '10')
          })
        )
        const content = JSON.stringify(corrections)
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ choices: [{ message: { content } }] }))
      })
    })
    await new Promise<void>((done) => helper.listen(0, '127.0.0.1', done))
    helperUrl = `http://127.0.0.1:${(helper.address() as AddressInfo).port}`
  }, 60_000)

  afterAll(async () => {
    mock?.close()
    helper?.close()
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  function config(
    changes: Partial<TranscriptionComponentConfig> = {}
  ): TranscriptionComponentConfig {
    return {
      ...TRANSCRIPTION_DEFAULT_CONFIG,
      asrBaseUrl: `${mockUrl}/asr/v1`,
      asrModels: [{ id: 'jlu/whisper-1', label: 'Whisper' }],
      providerName: 'KI@JLU',
      diarizationEnabled: true,
      diarizationUrl: `${mockUrl}/diarization/v1`,
      llmBaseUrl: `${helperUrl}/v1`,
      llmModels: [{ id: 'mock-chat', label: 'Mock' }],
      chunkSeconds: 10,
      ...changes
    }
  }

  async function storageWith(id: string, file: string): Promise<MemoryStorage> {
    const storage = new MemoryStorage()
    storage.objects.set(
      `transcription/${componentId}/jobs/${id}/source`,
      await readFile(join(directory, file))
    )
    return storage
  }

  function run(job: JobRow, storage: MemoryStorage, settings = config()): JobRun {
    const current: JobRun = {
      job,
      runtime: {
        type: 'transcription',
        componentId,
        config: settings,
        secrets: {
          apiKey: 'k',
          diarizationApiKey: null,
          llmApiKey: null,
          openaiRealtimeApiKey: null
        }
      },
      storage: storage as unknown as TranscriptionStorage,
      signal: new AbortController().signal,
      update: async (changes) => {
        current.job = { ...current.job, ...changes } as JobRow
        statuses.push(`${current.job.status}:${current.job.progress?.phase ?? ''}`)
        return current.job
      }
    }
    return current
  }

  it('probes, normalises and cuts audio, video included', async () => {
    const talk = await probeMedia(join(directory, 'talk.wav'))
    expect(talk.hasAudio).toBe(true)
    expect(talk.duration).toBeCloseTo(20, 1)
    const normalized = join(directory, 'clip-normalized.wav')
    await normalizeAudio(join(directory, 'clip.mp4'), normalized)
    const header = (await readFile(normalized)).subarray(0, 44)
    expect(header.toString('ascii', 0, 4)).toBe('RIFF')
    expect(header.readUInt16LE(22)).toBe(1)
    expect(header.readUInt32LE(24)).toBe(16_000)
    const cut = join(directory, 'cut.wav')
    await cutAudio(normalized, cut, 1, 3)
    expect((await probeMedia(cut)).duration).toBeCloseTo(2, 1)
    await expect(probeMedia(join(directory, 'invalid.wav'))).rejects.toBeInstanceOf(MediaToolError)
  })

  it('analyses, then transcribes with offsets, named voices and correction', async () => {
    const id = '00000000-0000-4000-8000-0000000000a1'
    const storage = await storageWith(id, 'talk.wav')
    statuses.length = 0
    const analysis = run(jobRow(id), storage)
    const analyzed = await runAnalysis(analysis)
    expect(analyzed).toMatchObject({ status: 'analyzed', error: null })
    expect(analysis.job.duration).toBeCloseTo(20, 1)
    expect(statuses).toEqual([
      'analyzing:normalizing',
      'analyzing:normalizing',
      'analyzing:diarizing'
    ])
    const speakers = analyzed.speakers!
    expect(speakers.map(({ id, label }) => ({ id, label }))).toEqual([
      { id: 'SPEAKER_00', label: 'Stimme 1' },
      { id: 'SPEAKER_01', label: 'Stimme 2' }
    ])
    const prefix = `transcription/${componentId}/jobs/${id}/`
    expect(storage.keys()).toEqual(
      [
        `${prefix}normalized.wav`,
        `${prefix}peaks.json`,
        ...speakers.flatMap((speaker) =>
          speaker.samples.map((sample) => `${prefix}samples/${sample.id}.wav`)
        ),
        `${prefix}source`
      ].sort()
    )
    // The waveform of the 20-second talk, for players that cannot decode the file (T-12).
    const waveform = transcriptionJobPeaksSchema.parse(
      JSON.parse(storage.objects.get(`${prefix}peaks.json`)!.toString('utf8'))
    )
    expect(waveform.duration).toBeCloseTo(20, 1)
    expect(Buffer.from(waveform.peaks, 'base64').length).toBe(400)

    // The user names both voices; Anna's window is her first sample.
    const window = (index: number): { start: number; end: number } => ({
      start: speakers[index]!.samples[0]!.start,
      end: speakers[index]!.samples[0]!.end
    })
    const snippets: TranscriptionSnippet[] = [
      { id: 'SPEAKER_00', name: 'Anna', ...window(0) },
      { id: 'SPEAKER_01', name: 'Ben', ...window(1) }
    ]
    statuses.length = 0
    const transcription = run(
      {
        ...analysis.job,
        ...analyzed,
        status: 'preprocessing',
        mapping: { SPEAKER_00: 'Anna', SPEAKER_01: 'Ben' },
        snippets,
        settings: { language: 'auto', speakerCount: 'auto', llmCorrection: true }
      } as JobRow,
      storage
    )
    const done = await runTranscription(transcription)
    expect(done.status).toBe('completed')
    const result = done.result!
    expect(result.language).toBe('de')
    expect(result.model).toBe('jlu/whisper-1')
    expect(result.provider).toBe('KI@JLU')
    expect(result.duration).toBeCloseTo(20, 1)
    // Two chunks of ten seconds, each recognised from 0 and moved by its start; the words map to
    // the voices, the correction merges one voice's neighbouring sentences as kiChat's does.
    expect(
      result.segments.map(({ id, start, end, speaker }) => ({ id, start, end, speaker }))
    ).toEqual([
      { id: 1, start: 0, end: 7.7, speaker: 'Anna' },
      { id: 2, start: 8, end: 13.7, speaker: 'Ben' },
      { id: 3, start: 14, end: expect.closeTo(19.7, 1), speaker: 'Anna' }
    ])
    expect(result.segments[1]!.text).toBe(
      'Wir treffen uns am Montag um 10 Uhr. Guten Tag und herzlich willkommen.'
    )
    expect(result.segments[0]).toMatchObject({ temperature: 0, compressionRatio: 0.98 })
    expect(result.text.startsWith('Guten Tag und herzlich willkommen.')).toBe(true)
    expect(result.words[0]).toMatchObject({ start: 0, word: ' Guten', speaker: 'Anna' })
    expect(result.words.find((word) => word.start >= 8)!.speaker).toBe('Ben')
    expect(done.error).toBeNull()
    expect(done.progress).toEqual({ phase: null, currentChunk: 2, totalChunks: 2, percent: 100 })
    expect(statuses).toContain('preprocessed:chunking')
    expect(statuses).toContain('transcribing:transcribing')
    expect(statuses).toContain('transcribing:diarizing')
    expect(statuses).toContain('optimizing:correcting')
    expect(storage.keys().filter((key) => key.includes('/asr/'))).toHaveLength(2)

    // The diariser recognises the named voices by their samples: no mapping needed.
    const known = await runTranscription(
      run(
        {
          ...transcription.job,
          status: 'preprocessing',
          mapping: {},
          settings: { language: 'auto', speakerCount: 'auto', llmCorrection: false }
        },
        storage
      )
    )
    expect(new Set(known.result!.segments.map((segment) => segment.speaker))).toEqual(
      new Set(['Anna', 'Ben'])
    )

    // `single` asks for one voice, which the diariser recognises as Anna's.
    const single = await runTranscription(
      run(
        {
          ...transcription.job,
          status: 'preprocessing',
          settings: { language: 'auto', speakerCount: 'single', llmCorrection: false }
        },
        storage
      )
    )
    expect(new Set(single.result!.segments.map((segment) => segment.speaker))).toEqual(
      new Set(['Anna'])
    )
  }, 60_000)

  it('diarises again at transcription with the count chosen then (T-09)', async () => {
    const id = '00000000-0000-4000-8000-0000000000a7'
    const storage = await storageWith(id, 'talk.wav')
    const analysis = run(
      jobRow(id, { settings: { language: 'auto', speakerCount: 'single', llmCorrection: false } }),
      storage
    )
    const analyzed = await runAnalysis(analysis)
    expect(analyzed.speakers).toHaveLength(1)
    expect(storage.objects.has(turnsKey(componentId, id))).toBe(false)

    const multi = run(
      {
        ...analysis.job,
        ...analyzed,
        status: 'preprocessing',
        settings: { language: 'auto', speakerCount: 'multi', llmCorrection: false }
      } as JobRow,
      storage
    )
    const done = await runTranscription(multi)
    expect(done.status).toBe('completed')
    expect(new Set(done.result!.segments.map((segment) => segment.speaker))).toEqual(
      new Set(['Stimme 1', 'Stimme 2'])
    )
  }, 60_000)

  it('maps segments without word timing as the HRZ gateway answers', async () => {
    const id = '00000000-0000-4000-8000-0000000000a9'
    const storage = await storageWith(id, 'talk.wav')
    const settings = config({ asrModels: [{ id: 'mock-gateway', label: 'Gateway' }] })
    const analysis = run(jobRow(id), storage, settings)
    const analyzed = await runAnalysis(analysis)
    const done = await runTranscription(
      run(
        {
          ...analysis.job,
          ...analyzed,
          status: 'preprocessing',
          mapping: { SPEAKER_00: 'Anna', SPEAKER_01: 'Ben' }
        } as JobRow,
        storage,
        settings
      )
    )
    const result = done.result!
    expect(result.words).toEqual([])
    expect(
      result.segments.map(({ id, start, end, speaker }) => ({ id, start, end, speaker }))
    ).toEqual([
      { id: 1, start: 0, end: 8, speaker: 'Anna' },
      { id: 2, start: 8, end: 14, speaker: 'Ben' },
      { id: 3, start: 14, end: expect.closeTo(20, 1), speaker: 'Anna' }
    ])
  }, 60_000)

  it('gives one automatic voice with a notice when the diariser is unavailable', async () => {
    const id = '00000000-0000-4000-8000-0000000000aa'
    const storage = await storageWith(id, 'talk.wav')
    const settings = config({ diarizationUrl: `${helperUrl}/none/v1` })
    const analysis = run(jobRow(id), storage, settings)
    const analyzed = await runAnalysis(analysis)
    expect(analyzed.status).toBe('analyzed')
    expect(analyzed.speakers).toEqual([
      expect.objectContaining({ id: 'SPEAKER_00', label: 'Stimme 1', start: 0, samples: [] })
    ])
    expect(analyzed.error).toEqual({
      code: 'diarization_failed',
      message:
        'Sprechererkennung nicht verfügbar (Diarization-Server antwortete mit Status 404). Die Datei hat eine automatische Stimme.'
    })
    const done = await runTranscription(
      run(
        {
          ...analysis.job,
          ...analyzed,
          status: 'preprocessing',
          error: null,
          mapping: { SPEAKER_00: 'Anna' }
        } as JobRow,
        storage,
        settings
      )
    )
    expect(done.status).toBe('completed')
    expect(new Set(done.result!.segments.map((segment) => segment.speaker))).toEqual(
      new Set(['Anna'])
    )
    expect(done.result!.words.every((word) => word.speaker === 'Anna')).toBe(true)
    expect(done.error).toMatchObject({ code: 'diarization_failed' })
  }, 60_000)

  it('fails a recognition longer than a transcript holds instead of cutting it', async () => {
    const id = '00000000-0000-4000-8000-0000000000a8'
    const storage = await storageWith(id, 'talk.wav')
    const settings = config({ chunkSeconds: 3600, diarizationEnabled: false })
    const analysis = run(jobRow(id), storage, settings)
    const analyzed = await runAnalysis(analysis)
    const count = TRANSCRIPTION_SEGMENTS_MAX + 1
    const segments = Array.from({ length: count }, (_, index) => ({
      start: (index * 19) / count,
      end: ((index + 1) * 19) / count,
      text: index === count - 1 ? 'TAIL_SHOULD_SURVIVE' : 'x',
      seek: null,
      temperature: null,
      avgLogprob: null,
      compressionRatio: null,
      noSpeechProb: null
    }))
    const chunk = { index: 0, start: 0, end: analysis.job.duration! }
    storage.objects.set(
      asrCacheKey(componentId, id, chunk, 'jlu/whisper-1', 'auto'),
      Buffer.from(JSON.stringify({ text: '', language: 'de', duration: 19, segments, words: [] }))
    )
    const failure = await runTranscription(
      run({ ...analysis.job, ...analyzed, status: 'preprocessing' } as JobRow, storage, settings)
    ).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(JobFailure)
    expect(failure).toMatchObject({ code: 'too_long' })
    expect(() => checkResultSize(TRANSCRIPTION_SEGMENTS_MAX, TRANSCRIPTION_WORDS_MAX)).not.toThrow()
    expect(() => checkResultSize(0, TRANSCRIPTION_WORDS_MAX + 1)).toThrow(JobFailure)
  }, 60_000)

  it('completes a long one-voice monologue the correction reads in batches (B-4)', async () => {
    const id = '00000000-0000-4000-8000-0000000000a9'
    const storage = await storageWith(id, 'talk.wav')
    const settings = config({ chunkSeconds: 3600, diarizationEnabled: false })
    const analysis = run(jobRow(id), storage, settings)
    const analyzed = await runAnalysis(analysis)
    // Three sentences of 9,000 characters without pauses: one voice would merge them into one
    // segment of 27,002 characters, beyond what a segment holds.
    const segments = [0, 1, 2].map((index) => ({
      start: index * 6,
      end: index * 6 + 6,
      text: `Teil ${index} `.padEnd(9000, 'a'),
      seek: null,
      temperature: null,
      avgLogprob: null,
      compressionRatio: null,
      noSpeechProb: null
    }))
    const chunk = { index: 0, start: 0, end: analysis.job.duration! }
    storage.objects.set(
      asrCacheKey(componentId, id, chunk, 'jlu/whisper-1', 'auto'),
      Buffer.from(JSON.stringify({ text: '', language: 'de', duration: 19, segments, words: [] }))
    )
    const done = await runTranscription(
      run(
        {
          ...analysis.job,
          ...analyzed,
          status: 'preprocessing',
          settings: { language: 'auto', speakerCount: 'single', llmCorrection: true }
        } as JobRow,
        storage,
        settings
      )
    )
    expect(done.status).toBe('completed')
    expect(done.error).toBeNull()
    const result = done.result!
    expect(result.segments.length).toBeGreaterThan(1)
    expect(result.segments.every((segment) => segment.text.length <= 20_000)).toBe(true)
    expect(result.text.replace(/\s+/g, '')).toBe(
      segments
        .map((segment) => segment.text)
        .join('')
        .replace(/\s+/g, '')
    )
  }, 60_000)

  it('takes the audio out of an MP4 video', async () => {
    const id = '00000000-0000-4000-8000-0000000000a2'
    const storage = await storageWith(id, 'clip.mp4')
    const analysis = run(jobRow(id, { filename: 'clip.mp4', mimeType: 'video/mp4' }), storage)
    const analyzed = await runAnalysis(analysis)
    expect(analyzed.status).toBe('analyzed')
    expect(analysis.job.duration).toBeCloseTo(5, 0)
    // Under eight seconds the mock hears one voice.
    expect(analyzed.speakers).toHaveLength(1)
  }, 60_000)

  it('fails undecodable audio as unsupported media', async () => {
    const id = '00000000-0000-4000-8000-0000000000a3'
    const storage = await storageWith(id, 'invalid.wav')
    await expect(runAnalysis(run(jobRow(id), storage))).rejects.toMatchObject({
      code: 'unsupported_media'
    })
  })

  it('reports a diarisation refusal as kiChat words it', async () => {
    const id = '00000000-0000-4000-8000-0000000000a4'
    const storage = await storageWith(id, 'talk.wav')
    const failure = await runAnalysis(
      run(jobRow(id), storage, config({ diarizationUrl: `${helperUrl}/d415/v1` }))
    ).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(JobFailure)
    expect(failure).toMatchObject({
      code: 'analysis_failed',
      message:
        'Fehler bei der Sprecher-Analyse: Sprecheranalyse fehlgeschlagen (Diarization-Server antwortete mit Status 415).'
    })
  }, 60_000)

  it('analyses one automatic voice when diarisation is off and refuses audio over the limit', async () => {
    const id = '00000000-0000-4000-8000-0000000000a5'
    const storage = await storageWith(id, 'talk.wav')
    storage.objects.set(turnsKey(componentId, id), Buffer.from('[]'))
    const analyzed = await runAnalysis(
      run(jobRow(id), storage, config({ diarizationEnabled: false }))
    )
    expect(analyzed.speakers).toEqual([
      {
        id: 'SPEAKER_00',
        index: 0,
        label: 'Stimme 1',
        start: 0,
        end: expect.closeTo(20, 1),
        samples: []
      }
    ])
    // Off is no failure: the capabilities say so, the job carries no notice.
    expect(analyzed.error).toBeNull()
    expect(storage.objects.has(turnsKey(componentId, id))).toBe(false)

    await expect(
      runAnalysis(run(jobRow(id), storage, config({ maxDurationSeconds: 10 })))
    ).rejects.toMatchObject({ code: 'too_long' })
  }, 60_000)

  it('fails a missing upload', async () => {
    const id = '00000000-0000-4000-8000-0000000000a6'
    await expect(runAnalysis(run(jobRow(id), new MemoryStorage()))).rejects.toMatchObject({
      code: 'upload_missing'
    })
  })
})
