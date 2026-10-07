import { createHash } from 'node:crypto'
import { join } from 'node:path'

import {
  TRANSCRIPTION_SEGMENTS_MAX,
  TRANSCRIPTION_WORDS_MAX,
  transcriptionResultSchema,
  type TranscriptionJobError,
  type TranscriptionJobPhase,
  type TranscriptionJobStatus,
  type TranscriptionSegment,
  type TranscriptionSpeaker,
  type TranscriptionWord
} from '@justcampus/shared'

import { asrBaseUrls, asrModel, diarizationSetup, type TranscriptionRuntime } from '../config.js'
import { UpstreamError } from '../http.js'
import { missingObject, objectKeys, type TranscriptionStorage } from '../storage.js'
import { chatTarget } from '../summaries/chat.js'
import { transcribeChunksParallel, type AsrResult } from './asr.js'
import { correctSegments, InvalidCorrectionError } from './correction.js'
import { diarizeFile, speechTimestamps, type DiarizationTurn } from './diarization.js'
import { upstreamLimiter } from './limiter.js'
import { mapDiarizationSegments } from './mapping.js'
import { cutAudio, MediaToolError, normalizeAudio, probeMedia, workDirectory } from './media.js'
import { joinText, mergeChunks, planChunks, type ChunkPlan } from './merge.js'
import { wavPeaks } from './peaks.js'
import { knownSpeakers, speakerNamesForTurns } from './references.js'
import { jobExpiry, type JobRow } from './rows.js'
import {
  automaticVoice,
  automaticVoiceName,
  normalizeTurns,
  speakersFromTurns
} from './speakers.js'
import type { JobChanges } from './store.js'
import { forwardStatus, JobFailure, progressOf } from './state.js'
import { isRetryableInTime, withRetry } from './upstream.js'

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

/**
 * Where earlier releases kept the analysis's turns; the transcription now diarises again with the
 * named voices, as kiChat does, and the analysis removes what an older run left.
 */
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
// Failures
// ---------------------------------------------------------------------------

/**
 * How an upstream failed, as kiChat words it in the message (`antwortete mit Status 415`), from
 * the error's `kind` and `status`, which the raw answer decided: never the upstream's words.
 */
export function upstreamReason(error: unknown, server: string): string {
  if (!(error instanceof UpstreamError)) return `${server} nicht erreichbar`
  switch (error.kind) {
    case 'invalidAnswer':
      return `${server} lieferte eine unerwartete Antwort`
    case 'status':
      return `${server} antwortete mit Status ${error.status}`
    case 'timeout':
      return `${server} zu langsam`
    case 'unreachable':
      return `${server} nicht erreichbar`
  }
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
    if (!signal.aborted && missingObject(error)) {
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
      if (!missingObject(error)) storageFailed(error, signal)
    }
  }
  return normalizeSource(run, directory)
}

/**
 * Whether a diarisation failure means the diariser is not there for this module: unreachable,
 * too slow, no such endpoint (the HRZ gateway has none), no access, a server error after the
 * retries, or an answer that is no diarisation. Other refusals (kiChat's `415` for an undecodable
 * file) fail the analysis as in kiChat. Decided by the error's `kind` and `status`, which the raw
 * answer decided, so masking a short key in its words cannot change it.
 */
export function diarizationUnavailable(error: unknown): boolean {
  if (!(error instanceof UpstreamError)) return false
  if (error.kind !== 'status' || error.status === null) return true
  return [401, 403, 404, 405, 408, 429].includes(error.status) || error.status >= 500
}

/** The notice an analysed or completed job carries when the diariser was unavailable. */
function diarizationNotice(error: unknown): TranscriptionJobError {
  return {
    code: 'diarization_failed',
    message: `Sprechererkennung nicht verfügbar (${upstreamReason(error, 'Diarization-Server')}). Die Datei hat eine automatische Stimme.`
  }
}

/** The budget follows the admin's setting before each use. */
function limiterFor(run: JobRun): typeof upstreamLimiter {
  upstreamLimiter.setLimit(run.runtime.config.asrConcurrency)
  return upstreamLimiter
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
    if (missingObject(error)) return null
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

/**
 * Stores the waveform of the normalised audio for players that cannot decode the file themselves
 * (T-12, T-19). A waveform is a preview only: if it cannot be computed, the analysis goes on and
 * the players draw placeholder bars.
 */
async function storeWaveform(run: JobRun, path: string): Promise<void> {
  let peaks: Awaited<ReturnType<typeof wavPeaks>>
  try {
    peaks = await wavPeaks(path, run.signal)
  } catch (error) {
    if (run.signal.aborted) throw error
    console.warn('Transcription waveform could not be computed', run.job.id, error)
    return
  }
  if (peaks) await writeJson(run, objectKeys.peaks(run.job.componentId, run.job.id), peaks)
}

// ---------------------------------------------------------------------------
// Speaker analysis (T-17, T-21)
// ---------------------------------------------------------------------------

/**
 * Phase 1, kiChat's `AnalyzeSpeakersJob`: checks and normalises the upload, diarises the whole
 * file and cuts the voices' samples (up to five per voice from its longest turns). A repeated
 * analysis replaces the samples. Without a diariser, or when it is unavailable, the file gets one
 * automatic voice instead of invented ones; an unavailable diariser leaves a
 * `diarization_failed` notice on the job.
 */
export async function runAnalysis(run: JobRun): Promise<JobChanges> {
  const { job, storage, signal, runtime } = run
  const directory = await workDirectory()
  try {
    await advance(run, 'analyzing', 'normalizing')
    const { path, duration } = await normalizeSource(run, directory.path)
    await storeWaveform(run, path)

    let speakers: TranscriptionSpeaker[] = [automaticVoice(duration)]
    let notice: TranscriptionJobError | null = null
    const setup = diarizationSetup(runtime.config, runtime.secrets)
    if (setup) {
      await advance(run, 'analyzing', 'diarizing')
      try {
        const turns = await diarizeFile(
          path,
          duration,
          { model: setup.model, speakerCount: run.job.settings.speakerCount },
          { baseUrl: setup.baseUrl, apiKey: setup.apiKey, limiter: limiterFor(run), signal }
        )
        speakers = speakersFromTurns(normalizeTurns(turns, duration), duration)
      } catch (error) {
        if (signal.aborted) throw error
        if (!diarizationUnavailable(error)) {
          console.error('Transcription speaker analysis failed', error)
          throw new JobFailure(
            'analysis_failed',
            `Fehler bei der Sprecher-Analyse: Sprecheranalyse fehlgeschlagen (${upstreamReason(error, 'Diarization-Server')}).`
          )
        }
        console.warn('Transcription diariser unavailable, one automatic voice', job.id, error)
        notice = diarizationNotice(error)
      }
    }

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
    await storageStep(signal, () => storage.delete(turnsKey(job.componentId, job.id)))

    return {
      status: 'analyzed',
      speakers,
      error: notice,
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

/** Every segment and word on the file's one automatic voice. */
function onAutomaticVoice(
  segments: readonly TranscriptionSegment[],
  words: readonly TranscriptionWord[],
  name: string
): { segments: TranscriptionSegment[]; words: TranscriptionWord[] } {
  return {
    segments: segments.map((segment) => ({ ...segment, speaker: name })),
    words: words.map((word) => ({ ...word, speaker: name }))
  }
}

/**
 * Phase 2, kiChat's `ProcessTranscriptionJob`: normalises (if the analysis did not), chunks,
 * recognises the chunks in parallel waves within the shared budget, diarises the whole file again
 * with the named voices as known speakers and the VAD's speech regions, maps the segments to the
 * voices by time overlap, and lets the chat model correct speakers and misheard words if asked.
 * A failing diarisation or correction does not fail the job, as in kiChat: the file keeps one
 * automatic voice, or the uncorrected text, with a notice.
 */
export async function runTranscription(run: JobRun): Promise<JobChanges> {
  const { job, signal, runtime } = run
  const { config, secrets } = runtime
  const model = asrModel(config)
  const workers = asrBaseUrls(config)
  if (workers.length === 0 || !model) {
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
    const results = new Array<AsrResult>(plan.length)
    const missing: ChunkPlan[] = []
    for (const chunk of plan) {
      const cached = await cachedRecognition(
        run,
        asrCacheKey(job.componentId, job.id, chunk, model.id, language)
      )
      if (cached) results[chunk.index] = cached
      else missing.push(chunk)
    }
    const cachedCount = plan.length - missing.length
    await advance(
      run,
      'transcribing',
      'transcribing',
      cachedCount,
      plan.length,
      (cachedCount / plan.length) * 90
    )
    if (missing.length > 0) {
      try {
        await transcribeChunksParallel(
          missing.map((chunk) => ({
            path: files[chunk.index]!,
            duration: chunk.end - chunk.start
          })),
          {
            baseUrls: workers,
            apiKey: secrets.apiKey,
            model: model.id,
            language,
            timeoutMs: config.upstreamTimeoutSeconds * 1000,
            limit: config.asrConcurrency,
            limiter: limiterFor(run),
            signal,
            onResult: async (index, result) => {
              const chunk = missing[index]!
              results[chunk.index] = result
              await writeJson(
                run,
                asrCacheKey(job.componentId, job.id, chunk, model.id, language),
                result
              )
            },
            onWave: (done) =>
              advance(
                run,
                'transcribing',
                'transcribing',
                cachedCount + done,
                plan.length,
                ((cachedCount + done) / plan.length) * 90
              )
          }
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
    }
    const merged = mergeChunks(
      plan.map((chunk) => ({ plan: chunk, result: results[chunk.index]! }))
    )
    // Nothing is cut off silently: a result beyond what a transcript holds fails clearly (before
    // the diarisation and correction would spend more on it).
    checkResultSize(merged.segments.length, merged.words.length)

    await advance(run, 'transcribing', 'diarizing', plan.length, plan.length, 90)
    let notice: TranscriptionJobError | null = null
    let named: { segments: TranscriptionSegment[]; words: TranscriptionWord[] } | null = null
    const setup = diarizationSetup(config, secrets)
    if (setup) {
      try {
        const limiter = limiterFor(run)
        const target = { baseUrl: setup.baseUrl, apiKey: setup.apiKey, limiter, signal }
        const known = await knownSpeakers(path, run.job.snippets, duration)
        const vadSegments = await speechTimestamps(path, duration, target)
        const turns: DiarizationTurn[] = await diarizeFile(
          path,
          duration,
          {
            model: setup.model,
            speakerCount: run.job.settings.speakerCount,
            knownSpeakers: known
          },
          target
        )
        named = mapDiarizationSegments(merged, turns, {
          vadSegments,
          speakerMapping: speakerNamesForTurns(turns, run.job.snippets, run.job.mapping),
          knownSpeakerNames: known.map((speaker) => speaker.name)
        })
      } catch (error) {
        if (signal.aborted) throw error
        console.error('Transcription diarisation failed, one automatic voice', job.id, error)
        notice = diarizationNotice(error)
      }
    }
    named ??= onAutomaticVoice(
      merged.segments,
      merged.words,
      automaticVoiceName(run.job.mapping, run.job.snippets)
    )

    await advance(run, 'optimizing', 'optimizing', 0, 0, 95)
    let segments = named.segments
    const correction = run.job.settings.llmCorrection ? chatTarget(runtime, 'correction') : null
    if (correction && segments.length > 0) {
      try {
        segments = await correctSegments(segments, correction, {
          signal,
          run: (call) => withRetry(call, { signal, when: isRetryableInTime }),
          onBatch: (done, total) =>
            advance(run, 'optimizing', 'correcting', done, total, 95 + (done / total) * 5)
        })
      } catch (error) {
        if (signal.aborted) throw error
        console.warn('Transcription correction failed, text left uncorrected', job.id, error)
        notice ??= {
          code: 'correction_failed',
          message:
            error instanceof InvalidCorrectionError
              ? `KI-Korrektur übersprungen: ${error.message}`
              : `KI-Korrektur übersprungen (${upstreamReason(error, 'Server')}).`
        }
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
      error: notice,
      completedAt: new Date(),
      progress: progressOf(null, plan.length, plan.length, 100),
      expiresAt: jobExpiry(config.unsavedJobRetentionHours)
    }
  } finally {
    await directory.dispose()
  }
}
