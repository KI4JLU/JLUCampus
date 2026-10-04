import { createHash } from 'node:crypto'
import { join } from 'node:path'

import {
  TRANSCRIPTION_SEGMENTS_MAX,
  TRANSCRIPTION_WORDS_MAX,
  transcriptionResultSchema,
  transcriptionSpeakerCountSchema,
  type TranscriptionJobPhase,
  type TranscriptionJobStatus,
  type TranscriptionSpeakerCount
} from '@justcampus/shared'
import { z } from 'zod'

import { asrModel, llmModel, type TranscriptionRuntime } from '../config.js'
import { UpstreamError } from '../http.js'
import { objectKeys, type TranscriptionStorage } from '../storage.js'
import { transcribeFile, type AsrResult } from './asr.js'
import { correctSegments } from './correction.js'
import { diarizeFile } from './diarization.js'
import { cutAudio, MediaToolError, normalizeAudio, probeMedia, workDirectory } from './media.js'
import { joinText, mergeChunks, planChunks, type ChunkPlan } from './merge.js'
import { jobExpiry, type JobRow } from './rows.js'
import {
  assignSpeakers,
  normalizeTurns,
  resolveSpeakerNames,
  speakersFromTurns,
  type SpeakerTurn
} from './speakers.js'
import type { JobChanges } from './store.js'
import { forwardStatus, JobFailure, progressOf } from './state.js'

/**
 * What the worker does with a claimed job: the speaker analysis after upload and the
 * transcription after dispatch. Each step writes its status and progress through `update`, which
 * fails once the job was deleted or the claim lost; `signal` then stops ffmpeg and upstream calls.
 * Both return the changes that finish the job; the worker writes them, or the failure.
 */
export interface JobRun {
  job: JobRow
  runtime: TranscriptionRuntime
  storage: TranscriptionStorage
  signal: AbortSignal
  update: (changes: JobChanges) => Promise<JobRow>
}

/** Where the analysis keeps the diarised turns the transcription names its segments by. */
export function turnsKey(componentId: string, jobId: string): string {
  return `${objectKeys.jobPrefix(componentId, jobId)}diarization.json`
}

/** Where a chunk's recognition is kept, so a resumed or repeated transcription skips it. */
export function asrCacheKey(
  componentId: string,
  jobId: string,
  chunk: ChunkPlan,
  model: string,
  language: string
): string {
  const hash = createHash('sha256')
    .update(`${model}|${language}|${chunk.start}|${chunk.end}`)
    .digest('hex')
    .slice(0, 16)
  return `${objectKeys.jobPrefix(componentId, jobId)}asr/${String(chunk.index).padStart(3, '0')}-${hash}.json`
}

function samplesPrefix(componentId: string, jobId: string): string {
  return `${objectKeys.jobPrefix(componentId, jobId)}samples/`
}

// ---------------------------------------------------------------------------
// Failures and retries
// ---------------------------------------------------------------------------

/** Tries an upstream call this often in all when it fails for a passing reason. */
const UPSTREAM_TRIES = 3
const RETRY_DELAYS_MS = [2_000, 6_000]

/** Network errors, timeouts, `408`, `429` and `5xx` pass; other answers will not change. */
export function isTransient(error: unknown): boolean {
  if (!(error instanceof UpstreamError)) return false
  return (
    error.status === null || error.status === 408 || error.status === 429 || error.status >= 500
  )
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, ms)
    const abort = (): void => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** Runs an upstream call, retrying passing failures a bounded number of times. */
export async function withRetries<T>(
  call: () => Promise<T>,
  signal: AbortSignal,
  delays: readonly number[] = RETRY_DELAYS_MS
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call()
    } catch (error) {
      if (signal.aborted || attempt >= UPSTREAM_TRIES || !isTransient(error)) throw error
      await sleep(delays[attempt - 1] ?? delays.at(-1) ?? 0, signal)
    }
  }
}

/** How an upstream failed, as kiChat words it in the message (`antwortete mit Status 415`). */
function upstreamReason(error: unknown, server: string): string {
  if (error instanceof UpstreamError && error.status !== null) {
    return `${server} antwortete mit Status ${error.status}`
  }
  if (error instanceof UpstreamError && /unexpected shape|JSON/.test(error.message)) {
    return `${server} lieferte eine unerwartete Antwort`
  }
  return `${server} nicht erreichbar`
}

/** Rethrows aborts and failures the step already classified; turns the rest into `failure`. */
function classify(error: unknown, signal: AbortSignal, failure: () => JobFailure): never {
  if (signal.aborted || error instanceof JobFailure) throw error
  throw failure()
}

/** A storage error as the job's failure (or the abort it was). */
function storageFailed(error: unknown, signal: AbortSignal): never {
  classify(error, signal, () => {
    console.error('Transcription storage step failed', error)
    return new JobFailure(
      'storage_failed',
      'Die Audiodatei konnte nicht gelesen oder gespeichert werden.'
    )
  })
}

async function storageStep<T>(signal: AbortSignal, call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (error) {
    storageFailed(error, signal)
  }
}

function isMissingObject(error: unknown): boolean {
  const named = error as { name?: string; $metadata?: { httpStatusCode?: number } } | null
  return named?.name === 'NoSuchKey' || named?.$metadata?.httpStatusCode === 404
}

// ---------------------------------------------------------------------------
// Shared steps
// ---------------------------------------------------------------------------

/** Progress written with a status that never goes back (a resumed job keeps its place). */
async function advance(
  run: JobRun,
  status: TranscriptionJobStatus,
  phase: TranscriptionJobPhase | null,
  currentChunk = 0,
  totalChunks = 0,
  percent: number | null = null
): Promise<void> {
  const next = forwardStatus(run.job.status as TranscriptionJobStatus, status)
  run.job = await run.update({
    status: next,
    progress: progressOf(phase, currentChunk, totalChunks, percent)
  })
}

/**
 * Downloads the upload, checks it is decodable audio within the duration limit (MP4 videos give
 * their audio track) and writes the normalised 16 kHz mono WAV next to it.
 */
async function normalizeSource(
  run: JobRun,
  directory: string
): Promise<{ path: string; duration: number }> {
  const { job, storage, signal, runtime } = run
  const source = join(directory, 'source')
  try {
    await storage.downloadToFile(job.objectKey, source, signal)
  } catch (error) {
    if (!signal.aborted && isMissingObject(error)) {
      throw new JobFailure('upload_missing', 'Die hochgeladene Datei wurde nicht gefunden.')
    }
    storageFailed(error, signal)
  }

  const unreadable = (): JobFailure =>
    new JobFailure('unsupported_media', 'Die Datei enthält keine lesbare Audiospur.')
  let info: Awaited<ReturnType<typeof probeMedia>>
  try {
    info = await probeMedia(source, signal)
  } catch (error) {
    classify(error, signal, unreadable)
  }
  if (!info.hasAudio) throw unreadable()
  const limit = runtime.config.maxDurationSeconds
  if (limit !== null && info.duration !== null && info.duration > limit) {
    throw new JobFailure(
      'too_long',
      `Die Aufnahme ist länger als erlaubt (höchstens ${Math.floor(limit / 60)} Minuten).`
    )
  }

  const normalized = join(directory, 'normalized.wav')
  try {
    await normalizeAudio(source, normalized, signal)
  } catch (error) {
    classify(error, signal, () => {
      if (error instanceof MediaToolError) console.warn('ffmpeg could not decode', error.detail)
      return unreadable()
    })
  }
  let duration = info.duration
  try {
    duration = (await probeMedia(normalized, signal)).duration ?? duration
  } catch (error) {
    classify(error, signal, unreadable)
  }
  if (duration === null || duration <= 0) throw unreadable()
  if (limit !== null && duration > limit) {
    throw new JobFailure(
      'too_long',
      `Die Aufnahme ist länger als erlaubt (höchstens ${Math.floor(limit / 60)} Minuten).`
    )
  }

  const key = objectKeys.normalized(job.componentId, job.id)
  await storageStep(signal, () => storage.uploadFile(key, normalized, 'audio/wav', signal))
  run.job = await run.update({ duration, normalizedKey: key })
  return { path: normalized, duration }
}

/** The normalised audio of an analysed job, made again from the upload if it is gone. */
async function normalizedAudio(
  run: JobRun,
  directory: string
): Promise<{ path: string; duration: number }> {
  const { job, storage, signal } = run
  if (job.normalizedKey) {
    const path = join(directory, 'normalized.wav')
    try {
      await storage.downloadToFile(job.normalizedKey, path, signal)
      let duration = job.duration
      try {
        duration = (await probeMedia(path, signal)).duration ?? duration
      } catch (error) {
        if (signal.aborted) throw error
      }
      if (duration !== null && duration > 0) return { path, duration }
    } catch (error) {
      if (signal.aborted) throw error
      if (!isMissingObject(error)) storageFailed(error, signal)
    }
  }
  return normalizeSource(run, directory)
}

function diarizationConfigured(run: JobRun): string | null {
  const { config } = run.runtime
  return config.diarizationEnabled && config.diarizationUrl ? config.diarizationUrl : null
}

async function diarize(run: JobRun, path: string, duration: number): Promise<SpeakerTurn[]> {
  const url = diarizationConfigured(run)
  if (!url) return []
  const { config, secrets } = run.runtime
  const turns = await withRetries(
    () =>
      diarizeFile(path, {
        url,
        apiKey: secrets.diarizationApiKey,
        model: config.diarizationModel,
        speakerCount: run.job.settings.speakerCount,
        timeoutMs: config.upstreamTimeoutSeconds * 1000,
        signal: run.signal
      }),
    run.signal
  )
  return normalizeTurns(turns, duration)
}

const turnListSchema = z.array(
  z.object({ start: z.number(), end: z.number(), speaker: z.string() })
)

/**
 * The diarised turns as the analysis keeps them, with the speaker count the diariser was asked
 * for: a transcription with another count must not reuse them (T-09).
 */
const storedTurnsSchema = z.object({
  speakerCount: transcriptionSpeakerCountSchema,
  turns: turnListSchema
})
type StoredTurns = z.infer<typeof storedTurnsSchema>

/** The kept turns, or `null` when there are none or they are unreadable. */
async function readTurns(run: JobRun): Promise<StoredTurns | null> {
  const stored = await readObject(run, turnsKey(run.job.componentId, run.job.id))
  if (!stored) return null
  const parsed = storedTurnsSchema.safeParse(parseJson(stored))
  return parsed.success ? parsed.data : null
}

/**
 * Whether turns diarised for `analysed` serve a transcription with `wanted`: the same count, or
 * `single`, which collapses any turns onto the dominant voice anyway.
 */
export function turnsServe(
  analysed: TranscriptionSpeakerCount,
  wanted: TranscriptionSpeakerCount
): boolean {
  return analysed === wanted || wanted === 'single'
}

function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    return undefined
  }
}

async function readObject(run: JobRun, key: string): Promise<Buffer | null> {
  try {
    const stream = await run.storage.get(key, run.signal)
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array))
    return Buffer.concat(chunks)
  } catch (error) {
    if (run.signal.aborted) throw error
    if (isMissingObject(error)) return null
    storageFailed(error, run.signal)
  }
}

async function writeJson(run: JobRun, key: string, value: unknown): Promise<void> {
  const body = Buffer.from(JSON.stringify(value))
  await storageStep(run.signal, () =>
    run.storage.put(key, body, {
      contentType: 'application/json',
      contentLength: body.length,
      signal: run.signal
    })
  )
}

// ---------------------------------------------------------------------------
// Speaker analysis (T-17, T-21)
// ---------------------------------------------------------------------------

/**
 * Checks and normalises the upload, diarises it and cuts the voices' samples. A repeated analysis
 * replaces the samples. Without diarisation the job is analysed with no voices.
 */
export async function runAnalysis(run: JobRun): Promise<JobChanges> {
  const { job, storage, signal, runtime } = run
  const directory = await workDirectory()
  try {
    await advance(run, 'analyzing', 'normalizing')
    const { path, duration } = await normalizeSource(run, directory.path)

    let turns: SpeakerTurn[] = []
    if (diarizationConfigured(run)) {
      await advance(run, 'analyzing', 'diarizing')
      try {
        turns = await diarize(run, path, duration)
      } catch (error) {
        classify(error, signal, () => {
          console.error('Transcription speaker analysis failed', error)
          return new JobFailure(
            'analysis_failed',
            `Fehler bei der Sprecher-Analyse: Sprecheranalyse fehlgeschlagen (${upstreamReason(error, 'Diarization-Server')}).`
          )
        })
      }
    }
    const speakers = speakersFromTurns(turns, duration)

    // The previous analysis's samples go, so nothing plays a voice that no longer exists.
    await storageStep(signal, () => storage.deletePrefix(samplesPrefix(job.componentId, job.id)))
    for (const sample of speakers.flatMap((speaker) => speaker.samples)) {
      const file = join(directory.path, `sample-${sample.id}.wav`)
      try {
        await cutAudio(path, file, sample.start, sample.end, signal)
      } catch (error) {
        classify(
          error,
          signal,
          () => new JobFailure('analysis_failed', 'Die Hörproben konnten nicht erstellt werden.')
        )
      }
      await storageStep(signal, () =>
        storage.uploadFile(
          objectKeys.sample(job.componentId, job.id, sample.id),
          file,
          'audio/wav',
          signal
        )
      )
    }
    const key = turnsKey(job.componentId, job.id)
    if (turns.length > 0) {
      await writeJson(run, key, { speakerCount: run.job.settings.speakerCount, turns })
    } else await storageStep(signal, () => storage.delete(key))

    return {
      status: 'analyzed',
      speakers,
      error: null,
      progress: progressOf(null, 0, 0, 100),
      expiresAt: jobExpiry(runtime.config.unsavedJobRetentionHours)
    }
  } finally {
    await directory.dispose()
  }
}

// ---------------------------------------------------------------------------
// Transcription (T-13, section 3)
// ---------------------------------------------------------------------------

/** With `single` chosen, every turn belongs to the voice that speaks most. */
export function singleSpeakerTurns(turns: readonly SpeakerTurn[]): SpeakerTurn[] {
  const spoken = new Map<string, number>()
  for (const turn of turns) {
    spoken.set(turn.speaker, (spoken.get(turn.speaker) ?? 0) + turn.end - turn.start)
  }
  const dominant = [...spoken.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  return dominant ? turns.map((turn) => ({ ...turn, speaker: dominant })) : []
}

/**
 * Fails a recognition with more segments or words than a transcript holds (the shared result
 * limits): cutting the tail off would claim a complete transcript that is not.
 */
export function checkResultSize(segments: number, words: number): void {
  if (segments <= TRANSCRIPTION_SEGMENTS_MAX && words <= TRANSCRIPTION_WORDS_MAX) return
  throw new JobFailure(
    'too_long',
    `Die Aufnahme ergibt mehr Text, als ein Transkript fassen kann (höchstens ${TRANSCRIPTION_SEGMENTS_MAX.toLocaleString('de-DE')} Abschnitte und ${TRANSCRIPTION_WORDS_MAX.toLocaleString('de-DE')} Wörter). Bitte die Datei in kürzere Teile schneiden.`
  )
}

/** The cached recognition of a chunk, if a previous run left one. */
async function cachedRecognition(run: JobRun, key: string): Promise<AsrResult | null> {
  const body = await readObject(run, key)
  return body ? ((parseJson(body) as AsrResult | undefined) ?? null) : null
}

/**
 * Normalises (if the analysis did not), chunks, recognises each chunk with its offset, names the
 * segments by the diarised voices and the user's windows, and corrects the text if asked.
 */
export async function runTranscription(run: JobRun): Promise<JobChanges> {
  const { job, signal, runtime } = run
  const { config, secrets } = runtime
  const model = asrModel(config)
  if (!config.asrBaseUrl || !model) {
    throw new JobFailure('asr_failed', 'Die Spracherkennung ist nicht eingerichtet.')
  }
  const directory = await workDirectory()
  try {
    await advance(run, 'preprocessing', 'normalizing')
    const { path, duration } = await normalizedAudio(run, directory.path)

    const plan = planChunks(duration, config.chunkSeconds)
    await advance(run, 'preprocessing', 'chunking', 0, plan.length)
    const files: string[] = []
    for (const chunk of plan) {
      if (plan.length === 1) {
        files.push(path)
        continue
      }
      const file = join(directory.path, `chunk-${chunk.index}.wav`)
      try {
        await cutAudio(path, file, chunk.start, chunk.end, signal)
      } catch (error) {
        classify(
          error,
          signal,
          () => new JobFailure('unsupported_media', 'Die Audiodatei konnte nicht geteilt werden.')
        )
      }
      files.push(file)
    }
    await advance(run, 'preprocessed', 'chunking', 0, plan.length)

    const language = run.job.settings.language
    const recognized: Array<{ plan: ChunkPlan; result: AsrResult }> = []
    for (const chunk of plan) {
      await advance(
        run,
        'transcribing',
        'transcribing',
        chunk.index,
        plan.length,
        (chunk.index / plan.length) * 90
      )
      const key = asrCacheKey(job.componentId, job.id, chunk, model.id, language)
      let result = await cachedRecognition(run, key)
      if (!result) {
        const previous = recognized.at(-1)?.result.text.slice(-200)
        try {
          result = await withRetries(
            () =>
              transcribeFile(files[chunk.index]!, chunk.end - chunk.start, {
                baseUrl: config.asrBaseUrl!,
                apiKey: secrets.apiKey,
                model: model.id,
                language,
                prompt: previous || undefined,
                timeoutMs: config.upstreamTimeoutSeconds * 1000,
                signal
              }),
            signal
          )
        } catch (error) {
          classify(error, signal, () => {
            console.error('Transcription recognition failed', error)
            return new JobFailure(
              'asr_failed',
              `Spracherkennung fehlgeschlagen (${upstreamReason(error, 'Server')}).`
            )
          })
        }
        await writeJson(run, key, result)
      }
      recognized.push({ plan: chunk, result })
    }
    const merged = mergeChunks(recognized)
    // Nothing is cut off silently: a result beyond what a transcript holds fails clearly (before
    // the diarisation and correction would spend more on it).
    checkResultSize(merged.segments.length, merged.words.length)

    await advance(run, 'transcribing', 'diarizing', plan.length, plan.length, 90)
    let turns: SpeakerTurn[] = []
    const speakerCount = run.job.settings.speakerCount
    const stored = await readTurns(run)
    if (stored && turnsServe(stored.speakerCount, speakerCount)) {
      turns = normalizeTurns(stored.turns, duration)
    } else if (diarizationConfigured(run)) {
      // No turns yet, or diarised for another count than the one chosen at dispatch: ask again.
      try {
        turns = await diarize(run, path, duration)
      } catch (error) {
        classify(error, signal, () => {
          console.error('Transcription diarisation failed', error)
          return new JobFailure(
            'diarization_failed',
            `Sprecherzuordnung fehlgeschlagen (${upstreamReason(error, 'Diarization-Server')}).`
          )
        })
      }
      if (turns.length > 0) {
        await writeJson(run, turnsKey(job.componentId, job.id), { speakerCount, turns })
      }
    } else if (stored) {
      // The diariser was switched off since the analysis: its turns are all there is.
      turns = normalizeTurns(stored.turns, duration)
    }
    if (speakerCount === 'single') turns = singleSpeakerTurns(turns)
    const names = resolveSpeakerNames(turns, run.job.speakers, run.job.mapping, run.job.snippets)
    const named = assignSpeakers(merged.segments, merged.words, turns, names, run.job.snippets)

    await advance(run, 'optimizing', 'optimizing', 0, 0, 95)
    let segments = named.segments
    const correctionModel = run.job.settings.llmCorrection ? llmModel(config, 'correction') : null
    if (correctionModel && config.llmBaseUrl && segments.length > 0) {
      try {
        segments = await correctSegments(
          segments,
          {
            baseUrl: config.llmBaseUrl,
            apiKey: secrets.llmApiKey,
            model: correctionModel,
            language: merged.language ?? (language === 'auto' ? null : language),
            timeoutMs: config.upstreamTimeoutSeconds * 1000,
            signal
          },
          {
            run: (call) => withRetries(call, signal),
            onBatch: (done, total) =>
              advance(run, 'optimizing', 'correcting', done, total, 95 + (done / total) * 5)
          }
        )
      } catch (error) {
        classify(error, signal, () => {
          console.error('Transcription correction failed', error)
          return new JobFailure(
            'correction_failed',
            `KI-Korrektur fehlgeschlagen (${upstreamReason(error, 'Server')}).`
          )
        })
      }
    }

    checkResultSize(segments.length, named.words.length)
    const result = transcriptionResultSchema.parse({
      text: joinText(segments),
      language: merged.language ?? (language === 'auto' ? null : language),
      duration,
      segments,
      words: named.words,
      model: model.id,
      provider: config.providerName
    })
    return {
      status: 'completed',
      result,
      error: null,
      completedAt: new Date(),
      progress: progressOf(null, plan.length, plan.length, 100),
      expiresAt: jobExpiry(config.unsavedJobRetentionHours)
    }
  } finally {
    await directory.dispose()
  }
}
