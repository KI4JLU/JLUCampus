/**
 * The transcription module (`transcription` in `SINGLETON_COMPONENT_TYPES`), ported from kiChat's
 * transcription service (see `docs/TRANSCRIPTION-REQUIREMENTS.md`, items T-01 to T-63). The server
 * runs the whole pipeline itself: browsers upload audio straight to S3-compatible storage with
 * signed URLs, the server normalises and chunks it with ffmpeg, analyses the voices with an HTTP
 * diarisation endpoint, transcribes with an OpenAI-compatible `/audio/transcriptions` endpoint and
 * corrects, summarises and reassigns speakers with an OpenAI-compatible chat endpoint. Live
 * transcription streams the microphone over a WebSocket to the server, which relays it to the
 * gateway's realtime endpoint or OpenAI Realtime.
 *
 * Everything at the HTTP boundary is camelCase; upstream snake_case is mapped in the server's
 * adapters. Every route lives under `TRANSCRIPTION_API` and derives the user from the session.
 */
import { z } from 'zod'
import { httpsUrlSchema, SECRET_VALUE_MAX } from './common'

// ---------------------------------------------------------------------------
// Files and limits
// ---------------------------------------------------------------------------

/** kiChat's per-file limit, inclusive (T-04). Admins may change it (`maxFileBytes`). */
export const TRANSCRIPTION_MAX_FILE_BYTES = 500 * 1024 * 1024

/** A file passes if its MIME type is one of these… */
export const TRANSCRIPTION_MIME_TYPES = [
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/m4a',
  'audio/ogg',
  'video/mp4'
] as const

/** …or its extension, case-insensitive, is one of these. MP4 is taken although the hint omits it. */
export const TRANSCRIPTION_EXTENSIONS = ['mp3', 'wav', 'm4a', 'mp4', 'ogg'] as const

export type TranscriptionFileCheck = 'ok' | 'unsupported' | 'tooLarge'

/**
 * kiChat's check before anything is uploaded (T-04): a supported MIME type or extension, and at
 * most `maxBytes` bytes. The server checks again, and the stored bytes after the upload.
 */
export function checkTranscriptionFile(
  file: { name: string; type: string; size: number },
  maxBytes: number = TRANSCRIPTION_MAX_FILE_BYTES
): TranscriptionFileCheck {
  const extension = file.name.includes('.') ? (file.name.split('.').pop() ?? '').toLowerCase() : ''
  const supported =
    (TRANSCRIPTION_MIME_TYPES as readonly string[]).includes(file.type) ||
    (TRANSCRIPTION_EXTENSIONS as readonly string[]).includes(extension)
  if (!supported) return 'unsupported'
  return file.size > maxBytes ? 'tooLarge' : 'ok'
}

export const TRANSCRIPTION_FILENAME_MAX = 255
/** Title and subtitle inputs of the workspace (T-23). */
export const TRANSCRIPTION_TITLE_MAX = 255
export const TRANSCRIPTION_SUBTITLE_MAX = 255
/** The title input of a history entry's rename action (T-23). */
export const TRANSCRIPTION_HISTORY_TITLE_MAX = 35
export const TRANSCRIPTION_SPEAKER_NAME_MAX = 100
export const TRANSCRIPTION_SEGMENT_TEXT_MAX = 20_000
/** Word timings one segment carries at most. */
export const TRANSCRIPTION_SEGMENT_WORDS_MAX = 5000
export const TRANSCRIPTION_SEGMENTS_MAX = 20_000
export const TRANSCRIPTION_WORDS_MAX = 200_000
export const TRANSCRIPTION_REDACTIONS_PER_SEGMENT_MAX = 500
/** Longest time any offset may name: a week, far beyond any recording. */
export const TRANSCRIPTION_SECONDS_MAX = 7 * 24 * 60 * 60
export const TRANSCRIPTION_SPEAKERS_MAX = 50
export const TRANSCRIPTION_SAMPLES_PER_SPEAKER_MAX = 20
/**
 * Files one transcript (an upload group) may combine at most. kiChat has no such limit, and the
 * admin's optional `maxFilesPerGroup` is the only product limit (unset: none, T-04, T-13); this
 * generous bound only guards the save request and the admin field against abuse.
 */
export const TRANSCRIPTION_GROUP_FILES_MAX = 1000

/** A voice sample's window, as the mapping dialog clamps it (T-19). */
export const TRANSCRIPTION_SAMPLE_MIN_SECONDS = 0.2
export const TRANSCRIPTION_SAMPLE_MAX_SECONDS = 5

/** Structural edits the result workspace can undo (T-34). */
export const TRANSCRIPTION_UNDO_MAX = 10

/** Status polling while a job analyses or transcribes; restored transcriptions poll slower (T-15). */
export const TRANSCRIPTION_POLL_MS = 2000
export const TRANSCRIPTION_RESTORED_POLL_MS = 3000
/** AI subtitles arrive after saving; the detail is fetched again this often, this many times (T-23). */
export const TRANSCRIPTION_SUBTITLE_POLL_ATTEMPTS = 5
export const TRANSCRIPTION_SUBTITLE_POLL_MS = 2000

/** Lifetime of a signed upload URL, and of signed playback and sample URLs. */
export const TRANSCRIPTION_UPLOAD_URL_TTL_SECONDS = 3600
export const TRANSCRIPTION_MEDIA_URL_TTL_SECONDS = 7200
/** A media URL that expires within this is fetched anew before use (T-21). */
export const TRANSCRIPTION_MEDIA_URL_REFRESH_SECONDS = 300

/** Unsaved, failed and cancelled jobs and their audio are deleted after this, as in kiChat. */
export const TRANSCRIPTION_UNSAVED_JOB_TTL_HOURS = 24

/**
 * Above this the browser decodes no waveform (T-12, T-24): the audio stays playable, and players
 * that know the job draw the waveform its analysis computed (`TRANSCRIPTION_API.jobPeaks`).
 */
export const TRANSCRIPTION_WAVEFORM_DECODE_MAX_BYTES = 100 * 1024 * 1024

/** What an inserted speaker block holds until edited, and empty text becomes (T-27, T-30). */
export const TRANSCRIPTION_EMPTY_SPEAKER_TEXT = '[Dieser Sprecher hat noch keinen Text!]'
/** What text exports put in place of a redacted range (T-33). */
export const TRANSCRIPTION_REDACTED_TEXT = '[AUSGEBLENDET]'

/** Font size of the live transcript, in CSS pixels (T-61). */
export const TRANSCRIPTION_LIVE_FONT_SIZE = { min: 32, max: 100, default: 32 } as const

/**
 * Automatic voice labels in either language (`Stimme 2`, `Speaker 2`, …), which the web app shows
 * localised; names users typed stay as they are (T-02, T-46).
 */
export const TRANSCRIPTION_AUTO_SPEAKER_LABEL =
  /^(?:Stimme|Voice|Sprecher(?:in)?|Speaker)\s*(\d+)?$/i

// ---------------------------------------------------------------------------
// Upload settings
// ---------------------------------------------------------------------------

/** Spoken language of a batch job: detected or fixed (T-09). The detected one is a plain string. */
export const TRANSCRIPTION_LANGUAGES = ['auto', 'de', 'en'] as const
export const transcriptionLanguageSchema = z.enum(TRANSCRIPTION_LANGUAGES)
export type TranscriptionLanguage = z.infer<typeof transcriptionLanguageSchema>

/** How many people speak: detected, one, or several (T-09); there is no numeric count. */
export const TRANSCRIPTION_SPEAKER_COUNTS = ['auto', 'single', 'multi'] as const
export const transcriptionSpeakerCountSchema = z.enum(TRANSCRIPTION_SPEAKER_COUNTS)
export type TranscriptionSpeakerCount = z.infer<typeof transcriptionSpeakerCountSchema>

export const transcriptionJobSettingsSchema = z.object({
  language: transcriptionLanguageSchema,
  speakerCount: transcriptionSpeakerCountSchema,
  /** Whether the chat model corrects the recognised text. */
  llmCorrection: z.boolean()
})
export type TranscriptionJobSettings = z.infer<typeof transcriptionJobSettingsSchema>

// ---------------------------------------------------------------------------
// Speakers and colours
// ---------------------------------------------------------------------------

/** The ten avatar colours (T-18, T-25), numbered 1 to 10 as in kiChat. */
export const TRANSCRIPTION_SPEAKER_COLOR_IDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const
export type TranscriptionSpeakerColorId = (typeof TRANSCRIPTION_SPEAKER_COLOR_IDS)[number]
export const transcriptionSpeakerColorIdSchema = z.literal([...TRANSCRIPTION_SPEAKER_COLOR_IDS])

/**
 * kiChat's solid speaker colours (`SPEAKER_BAR_COLORS`), for the waveform's speaker timeline and
 * avatars. The design system has no categorical palette of ten yet.
 */
export const TRANSCRIPTION_SPEAKER_COLORS: Record<TranscriptionSpeakerColorId, string> = {
  1: '#3b82f6',
  2: '#a855f7',
  3: '#f97316',
  4: '#a3e635',
  5: '#ec4899',
  6: '#fde047',
  7: '#22d3ee',
  8: '#6366f1',
  9: '#14b8a6',
  10: '#f43f5e'
}

/** The colour a speaker gets when none was chosen: by order of appearance, cycling through ten. */
export function defaultSpeakerColorId(speakerIndex: number): TranscriptionSpeakerColorId {
  return ((Math.max(0, Math.floor(speakerIndex)) % 10) + 1) as TranscriptionSpeakerColorId
}

const secondsSchema = z.number().finite().min(0).max(TRANSCRIPTION_SECONDS_MAX)
const speakerNameSchema = z.string().trim().min(1).max(TRANSCRIPTION_SPEAKER_NAME_MAX)
/** The id diarisation gives a voice (`SPEAKER_00`), or one the mapping dialog made for a new voice. */
export const transcriptionSpeakerIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[\w.:-]+$/, 'Expected a speaker id')

/**
 * Speaker colours of a transcript, keyed by speaker name, as kiChat keeps them
 * (`speaker_color_map`): the colour and the speaker's order of appearance.
 */
export const transcriptionSpeakerColorMapSchema = z
  .record(
    z.string().max(TRANSCRIPTION_SPEAKER_NAME_MAX),
    z.object({
      colorId: transcriptionSpeakerColorIdSchema,
      speakerIndex: z.number().int().min(0)
    })
  )
  .refine((map) => Object.keys(map).length <= TRANSCRIPTION_SEGMENTS_MAX, {
    message: 'Too many speakers'
  })
export type TranscriptionSpeakerColorMap = z.infer<typeof transcriptionSpeakerColorMapSchema>

/** One time window of a voice: a sample the analysis found or the user chose (T-19). */
export const transcriptionSampleSchema = z
  .object({
    /** Stable within its job; `GET TRANSCRIPTION_API.jobSample` plays it. */
    id: z.string().trim().min(1).max(64),
    start: secondsSchema,
    end: secondsSchema
  })
  .refine((sample) => sample.end > sample.start, { message: 'end must be after start' })
export type TranscriptionSample = z.infer<typeof transcriptionSampleSchema>

/** A voice the speaker analysis found (T-17). */
export const transcriptionSpeakerSchema = z.object({
  id: transcriptionSpeakerIdSchema,
  /** Order of appearance from 0; the web app names unnamed voices `Voice <index + 1>`. */
  index: z.number().int().min(0),
  /** The diarisation's own label, if any; informational, the web app localises automatic ones. */
  label: z.string().max(TRANSCRIPTION_SPEAKER_NAME_MAX).nullable(),
  /** First and last moment the voice speaks. */
  start: secondsSchema,
  end: secondsSchema,
  samples: z.array(transcriptionSampleSchema).max(TRANSCRIPTION_SAMPLES_PER_SPEAKER_MAX)
})
export type TranscriptionSpeaker = z.infer<typeof transcriptionSpeakerSchema>

/**
 * A named voice window sent with dispatch (kiChat's `speaker_snippets`). The server names the
 * diarised speakers after the named voice whose windows overlap them most, so voices the user added
 * by hand work too.
 */
export const transcriptionSnippetSchema = z
  .object({
    id: transcriptionSpeakerIdSchema,
    name: speakerNameSchema,
    start: secondsSchema,
    end: secondsSchema
  })
  .refine((snippet) => snippet.end > snippet.start, { message: 'end must be after start' })
export type TranscriptionSnippet = z.infer<typeof transcriptionSnippetSchema>

// ---------------------------------------------------------------------------
// Segments and words
// ---------------------------------------------------------------------------

/** A redacted character range of a segment's text, `end` exclusive (T-33). */
export const transcriptionRedactionSchema = z
  .object({
    start: z.number().int().min(0),
    end: z.number().int().min(0)
  })
  .refine((range) => range.end > range.start, { message: 'end must be after start' })
export type TranscriptionRedaction = z.infer<typeof transcriptionRedactionSchema>

/** A recognised word with its timing, when the engine gives words. */
export const transcriptionWordSchema = z
  .object({
    start: secondsSchema,
    end: secondsSchema,
    word: z.string().max(200),
    probability: z.number().finite().nullable().optional(),
    speaker: z.string().max(TRANSCRIPTION_SPEAKER_NAME_MAX).nullable().optional()
  })
  .refine((word) => word.end >= word.start, { message: 'end must not be before start' })
export type TranscriptionWord = z.infer<typeof transcriptionWordSchema>

/**
 * One segment of a transcript. The decoder fields of a Whisper-style answer are kept, camelCased,
 * so the raw JSON export carries them (T-47); edits must leave them alone unless they transform
 * the segment. Text is plain text, never HTML.
 */
export const transcriptionSegmentSchema = z
  .object({
    /** Unique within its transcript; splits take the next free number. */
    id: z.number().int().min(0),
    start: secondsSchema,
    end: secondsSchema,
    text: z.string().max(TRANSCRIPTION_SEGMENT_TEXT_MAX),
    /** The speaker's name; `null` when no voice could be assigned. */
    speaker: z.string().max(TRANSCRIPTION_SPEAKER_NAME_MAX).nullable(),
    /** Sorted, merged ranges of `text`; editing the text clears them. */
    redactions: z
      .array(transcriptionRedactionSchema)
      .max(TRANSCRIPTION_REDACTIONS_PER_SEGMENT_MAX)
      .default([]),
    words: z.array(transcriptionWordSchema).max(TRANSCRIPTION_SEGMENT_WORDS_MAX).optional(),
    avgLogprob: z.number().finite().nullable().optional(),
    compressionRatio: z.number().finite().nullable().optional(),
    noSpeechProb: z.number().finite().nullable().optional(),
    temperature: z.number().finite().nullable().optional(),
    seek: z.number().int().nullable().optional(),
    tokens: z.array(z.number().int()).max(5000).optional()
  })
  .refine((segment) => segment.end >= segment.start, {
    message: 'end must not be before start',
    path: ['end']
  })
  .refine((segment) => segment.redactions.every((range) => range.end <= segment.text.length), {
    message: 'A redaction lies outside the text',
    path: ['redactions']
  })
export type TranscriptionSegment = z.infer<typeof transcriptionSegmentSchema>
export type TranscriptionSegmentInput = z.input<typeof transcriptionSegmentSchema>

/** The segments of a result or transcript: at most `TRANSCRIPTION_SEGMENTS_MAX`, unique ids. */
export const transcriptionSegmentsSchema = z
  .array(transcriptionSegmentSchema)
  .max(TRANSCRIPTION_SEGMENTS_MAX)
  .refine((segments) => new Set(segments.map((segment) => segment.id)).size === segments.length, {
    message: 'Segment ids must be unique'
  })
const wordsSchema = z.array(transcriptionWordSchema).max(TRANSCRIPTION_WORDS_MAX)

/** What a finished job recognised: the whole text, its segments and words. */
export const transcriptionResultSchema = z.object({
  text: z.string(),
  /** The detected (or fixed) language, e.g. `de`. */
  language: z.string().max(16).nullable(),
  /** Seconds of audio the result covers, if known. */
  duration: secondsSchema.nullable(),
  segments: transcriptionSegmentsSchema,
  words: wordsSchema,
  /** The speech model and provider as the admin named them, for display and the saved record. */
  model: z.string().max(200).nullable(),
  provider: z.string().max(80).nullable()
})
export type TranscriptionResult = z.infer<typeof transcriptionResultSchema>

// ---------------------------------------------------------------------------
// Jobs (one uploaded file each)
// ---------------------------------------------------------------------------

/**
 * A job's life (section 3): `uploading` until the browser's PUT is confirmed by `analyze`, the
 * speaker analysis (`analyzingQueued`, `analyzing`, `analyzed`), then after dispatch
 * normalisation and chunking (`preprocessing`, `preprocessed`), recognition and diarisation
 * (`transcribing`), the LLM correction (`optimizing`) and `completed`. `failed` and `cancelled`
 * end it too. A completed job is not yet a saved transcript.
 */
export const TRANSCRIPTION_JOB_STATUSES = [
  'uploading',
  'analyzingQueued',
  'analyzing',
  'analyzed',
  'preprocessing',
  'preprocessed',
  'transcribing',
  'optimizing',
  'completed',
  'failed',
  'cancelled'
] as const
export const transcriptionJobStatusSchema = z.enum(TRANSCRIPTION_JOB_STATUSES)
export type TranscriptionJobStatus = z.infer<typeof transcriptionJobStatusSchema>

export const TRANSCRIPTION_TERMINAL_STATUSES = [
  'completed',
  'failed',
  'cancelled'
] as const satisfies readonly TranscriptionJobStatus[]
/** The server is working on the speaker analysis. */
export const TRANSCRIPTION_ANALYSIS_STATUSES = [
  'analyzingQueued',
  'analyzing'
] as const satisfies readonly TranscriptionJobStatus[]
/** The server is working on the transcription after dispatch. */
export const TRANSCRIPTION_PROCESSING_STATUSES = [
  'preprocessing',
  'preprocessed',
  'transcribing',
  'optimizing'
] as const satisfies readonly TranscriptionJobStatus[]

export function isTerminalJobStatus(status: TranscriptionJobStatus): boolean {
  return (TRANSCRIPTION_TERMINAL_STATUSES as readonly TranscriptionJobStatus[]).includes(status)
}

/** Whether the client should keep polling the job. */
export function isActiveJobStatus(status: TranscriptionJobStatus): boolean {
  return (
    (TRANSCRIPTION_ANALYSIS_STATUSES as readonly TranscriptionJobStatus[]).includes(status) ||
    (TRANSCRIPTION_PROCESSING_STATUSES as readonly TranscriptionJobStatus[]).includes(status)
  )
}

/** What the worker is doing within a status. */
export const TRANSCRIPTION_JOB_PHASES = [
  'queued',
  'normalizing',
  'chunking',
  'transcribing',
  'diarizing',
  'correcting',
  'optimizing',
  'merging'
] as const
export type TranscriptionJobPhase = (typeof TRANSCRIPTION_JOB_PHASES)[number]

export const transcriptionProgressSchema = z.object({
  phase: z.enum(TRANSCRIPTION_JOB_PHASES).nullable(),
  /** Chunk being worked on, from 0, of `totalChunks`; both 0 before chunking (T-11). */
  currentChunk: z.number().int().min(0),
  totalChunks: z.number().int().min(0),
  /** The server's estimate, if it has one. */
  percent: z.number().min(0).max(100).nullable()
})
export type TranscriptionProgress = z.infer<typeof transcriptionProgressSchema>

/**
 * Share of the work done in percent: the server's estimate, else done chunks of all chunks, else
 * `null`. Totals of zero never divide (T-11).
 */
export function progressPercent(progress: TranscriptionProgress | null): number | null {
  if (!progress) return null
  if (progress.percent !== null) return progress.percent
  if (progress.totalChunks <= 0) return null
  return Math.min(100, Math.max(0, (progress.currentChunk / progress.totalChunks) * 100))
}

/** Why a job failed; `message` adds safe detail, e.g. an upstream status, possibly in German. */
export const TRANSCRIPTION_JOB_ERROR_CODES = [
  'upload_missing',
  'upload_size_mismatch',
  'unsupported_media',
  'too_long',
  'analysis_failed',
  'asr_failed',
  'diarization_failed',
  'correction_failed',
  'storage_failed',
  'expired',
  'internal'
] as const
export const transcriptionJobErrorSchema = z.object({
  code: z.enum(TRANSCRIPTION_JOB_ERROR_CODES),
  message: z.string().max(2000)
})
export type TranscriptionJobError = z.infer<typeof transcriptionJobErrorSchema>

/** `POST TRANSCRIPTION_API.jobs`: a new job for one file, before its bytes are uploaded. */
export const transcriptionJobCreateSchema = z
  .object({
    filename: z.string().trim().min(1).max(TRANSCRIPTION_FILENAME_MAX),
    /** Bytes the browser will upload; the signed URL accepts exactly these. */
    size: z.number().int().positive(),
    /** The browser's type, often empty for recordings and some files. */
    mimeType: z.string().trim().max(255).default(''),
    language: transcriptionLanguageSchema.default('auto'),
    speakerCount: transcriptionSpeakerCountSchema.default('auto'),
    llmCorrection: z.boolean().default(true),
    /** The upload group (one transcript) this file belongs to and its place there (T-06, T-07). */
    groupId: z.uuid().nullable().default(null),
    groupOrder: z.number().int().min(0).max(TRANSCRIPTION_GROUP_FILES_MAX).default(0)
  })
  .refine(
    (input) =>
      checkTranscriptionFile({ name: input.filename, type: input.mimeType, size: 0 }) === 'ok',
    { message: 'Unsupported file type', path: ['filename'] }
  )
export type TranscriptionJobCreate = z.input<typeof transcriptionJobCreateSchema>

/** Where and how the browser uploads the bytes: one signed `PUT`, with exactly these headers. */
export const transcriptionUploadTargetSchema = z.object({
  url: z.url(),
  method: z.literal('PUT'),
  headers: z.record(z.string(), z.string()),
  expiresAt: z.iso.datetime()
})
export type TranscriptionUploadTarget = z.infer<typeof transcriptionUploadTargetSchema>

/** `POST TRANSCRIPTION_API.jobAnalyze`: the upload is done; the duration the browser measured. */
export const transcriptionAnalyzeSchema = z.object({
  /** A hint only: the server measures the media itself. */
  duration: secondsSchema.nullable().default(null),
  /** The speaker count chosen now, if it changed since upload (T-09); the diariser gets it. */
  speakerCount: transcriptionSpeakerCountSchema.optional()
})
export type TranscriptionAnalyze = z.input<typeof transcriptionAnalyzeSchema>

/**
 * `POST TRANSCRIPTION_API.jobDispatch`: names, voice windows and settings (T-18 to T-20). Names
 * travel with dispatch; there is no separate save of the mapping. Windows must lie within the
 * media, which the server checks.
 */
export const transcriptionDispatchSchema = z.object({
  /** Detected speaker id → name the user gave. */
  mapping: z
    .record(transcriptionSpeakerIdSchema, z.string().trim().max(TRANSCRIPTION_SPEAKER_NAME_MAX))
    .refine((mapping) => Object.keys(mapping).length <= TRANSCRIPTION_SPEAKERS_MAX, {
      message: 'Too many speakers'
    }),
  snippets: z
    .array(transcriptionSnippetSchema)
    .max(TRANSCRIPTION_SPEAKERS_MAX * TRANSCRIPTION_SAMPLES_PER_SPEAKER_MAX),
  speakerCount: transcriptionSpeakerCountSchema,
  llmCorrection: z.boolean(),
  /** Changes the language chosen at upload (Q-07: kiChat does not resend it). */
  language: transcriptionLanguageSchema.optional(),
  /** Speaker id → colour the mapping dialog chose. */
  colors: z.record(transcriptionSpeakerIdSchema, transcriptionSpeakerColorIdSchema).default({})
})
export type TranscriptionDispatch = z.input<typeof transcriptionDispatchSchema>

/** One of the user's jobs. No storage paths or upstream credentials ever leave the server. */
export const transcriptionJobSchema = z.object({
  id: z.uuid(),
  filename: z.string(),
  size: z.number().int().min(0),
  mimeType: z.string(),
  /** Measured by the server once analysed; until then the browser's hint, if any. */
  duration: secondsSchema.nullable(),
  groupId: z.uuid().nullable(),
  groupOrder: z.number().int().min(0),
  settings: transcriptionJobSettingsSchema,
  status: transcriptionJobStatusSchema,
  progress: transcriptionProgressSchema.nullable(),
  /** The analysed voices, by order of appearance; empty before the analysis. */
  speakers: z.array(transcriptionSpeakerSchema).max(TRANSCRIPTION_SPEAKERS_MAX),
  /** As last dispatched; empty before. */
  mapping: z.record(z.string(), z.string()),
  snippets: z.array(transcriptionSnippetSchema),
  colors: z.record(z.string(), transcriptionSpeakerColorIdSchema),
  /**
   * Why a `failed` job failed. On an `analyzed` or `completed` job it is a notice instead: with
   * `diarization_failed` the diariser was unavailable and the file has one automatic voice, with
   * `correction_failed` the text stayed uncorrected.
   */
  error: transcriptionJobErrorSchema.nullable(),
  /** Set once `completed`, and only in the answer of `GET TRANSCRIPTION_API.job`; lists leave it out. */
  result: transcriptionResultSchema.nullable(),
  /** The saved transcript this job went into, if any. */
  transcriptId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /** When the server deletes the job and its audio unless it is saved first. */
  expiresAt: z.iso.datetime().nullable()
})
export type TranscriptionJob = z.infer<typeof transcriptionJobSchema>

/** `POST TRANSCRIPTION_API.jobs` → 201: the job and where to upload its bytes. */
export const transcriptionJobCreatedSchema = z.object({
  job: transcriptionJobSchema,
  upload: transcriptionUploadTargetSchema
})
export type TranscriptionJobCreated = z.infer<typeof transcriptionJobCreatedSchema>

/** `GET TRANSCRIPTION_API.jobs`: the user's jobs not yet saved, deleted or expired (T-15). */
export const transcriptionJobListSchema = z.object({ jobs: z.array(transcriptionJobSchema) })
export type TranscriptionJobList = z.infer<typeof transcriptionJobListSchema>

/** A fresh signed URL for playback; it expires and must not be stored. */
export const transcriptionMediaUrlSchema = z.object({
  url: z.url(),
  expiresAt: z.iso.datetime()
})
export type TranscriptionMediaUrl = z.infer<typeof transcriptionMediaUrlSchema>

/** Waveform peaks per second of audio the analysis computes, as kiChat's editor draws them. */
export const TRANSCRIPTION_PEAKS_PER_SECOND = 20

/**
 * `GET TRANSCRIPTION_API.jobPeaks`: the waveform the analysis computed from the normalised audio
 * with ffmpeg, for files too large to decode in the browser (T-12, T-19).
 */
export const transcriptionJobPeaksSchema = z.object({
  perSecond: z.literal(TRANSCRIPTION_PEAKS_PER_SECOND),
  duration: secondsSchema,
  /** One byte per peak, 0 to 255 scaled to the loudest, base64-encoded. */
  peaks: z.base64()
})
export type TranscriptionJobPeaks = z.infer<typeof transcriptionJobPeaksSchema>

// ---------------------------------------------------------------------------
// Saved transcripts (history)
// ---------------------------------------------------------------------------

const titleSchema = z.string().trim().min(1).max(TRANSCRIPTION_TITLE_MAX)

/** Where in the combined transcript one uploaded file lies (T-14). */
export const transcriptionSourceFileSchema = z.object({
  jobId: z.uuid().nullable(),
  name: z.string().max(TRANSCRIPTION_FILENAME_MAX),
  size: z.number().int().min(0),
  duration: secondsSchema.nullable(),
  startTime: secondsSchema,
  endTime: secondsSchema
})
export type TranscriptionSourceFile = z.infer<typeof transcriptionSourceFileSchema>

export const TRANSCRIPTION_SUBTITLE_SOURCES = ['ai', 'manual'] as const
export type TranscriptionSubtitleSource = (typeof TRANSCRIPTION_SUBTITLE_SOURCES)[number]

/** A history entry (T-37). */
export const transcriptionTranscriptSummarySchema = z.object({
  id: z.uuid(),
  title: z.string(),
  subtitle: z.string().nullable(),
  language: z.string().nullable(),
  duration: z.number().nullable(),
  originalFilename: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /** Set when the admin's retention removes it then. */
  expiresAt: z.iso.datetime().nullable()
})
export type TranscriptionTranscriptSummary = z.infer<typeof transcriptionTranscriptSummarySchema>

/** `GET TRANSCRIPTION_API.transcripts`: the user's history, newest change first, unpaged. */
export const transcriptionTranscriptListSchema = z.object({
  transcripts: z.array(transcriptionTranscriptSummarySchema)
})
export type TranscriptionTranscriptList = z.infer<typeof transcriptionTranscriptListSchema>

/** A saved transcript with everything the result workspace edits. */
export const transcriptionTranscriptSchema = transcriptionTranscriptSummarySchema.extend({
  subtitleSource: z.enum(TRANSCRIPTION_SUBTITLE_SOURCES).nullable(),
  model: z.string().nullable(),
  provider: z.string().nullable(),
  fileSize: z.number().int().min(0).nullable(),
  /** The plain text of all segments. */
  text: z.string(),
  segments: z.array(transcriptionSegmentSchema),
  words: z.array(transcriptionWordSchema),
  sourceFiles: z.array(transcriptionSourceFileSchema),
  speakerColors: transcriptionSpeakerColorMapSchema,
  /** The summary template last used for it. */
  summaryTemplateId: z.string().nullable(),
  /** Grows with every change; `PATCH` must name the revision it started from. */
  revision: z.number().int().min(1)
})
export type TranscriptionTranscript = z.infer<typeof transcriptionTranscriptSchema>

/**
 * `POST TRANSCRIPTION_API.transcripts`: saves one group's merged result once (T-13, T-14). The same
 * `idempotencyKey` answers the transcript saved first instead of saving twice. The jobs must be the
 * user's and completed; they leave the active list.
 */
export const transcriptionTranscriptCreateSchema = z.object({
  idempotencyKey: z.uuid(),
  title: titleSchema,
  /** The group's jobs in queue order. */
  jobIds: z.array(z.uuid()).min(1).max(TRANSCRIPTION_GROUP_FILES_MAX),
  language: z.string().max(16).nullable(),
  duration: secondsSchema.nullable(),
  segments: transcriptionSegmentsSchema,
  words: wordsSchema.default([]),
  sourceFiles: z.array(transcriptionSourceFileSchema).max(TRANSCRIPTION_GROUP_FILES_MAX),
  speakerColors: transcriptionSpeakerColorMapSchema.default({})
})
export type TranscriptionTranscriptCreate = z.input<typeof transcriptionTranscriptCreateSchema>

/**
 * `PATCH TRANSCRIPTION_API.transcript`: title, subtitle, segments and colours change independently.
 * A `baseRevision` other than the stored one answers `409 conflict`, so overlapping edits are not
 * lost (T-35). An empty subtitle removes it.
 */
export const transcriptionTranscriptPatchSchema = z
  .object({
    baseRevision: z.number().int().min(1),
    title: titleSchema.optional(),
    subtitle: z.string().trim().max(TRANSCRIPTION_SUBTITLE_MAX).optional(),
    segments: transcriptionSegmentsSchema.optional(),
    speakerColors: transcriptionSpeakerColorMapSchema.optional(),
    summaryTemplateId: z.string().trim().min(1).max(100).nullable().optional()
  })
  .refine(
    (patch) =>
      Object.entries(patch).some(([key, value]) => key !== 'baseRevision' && value !== undefined),
    { message: 'Change at least one field' }
  )
export type TranscriptionTranscriptPatch = z.input<typeof transcriptionTranscriptPatchSchema>

// ---------------------------------------------------------------------------
// Transcript formats (export presets)
// ---------------------------------------------------------------------------

export const TRANSCRIPT_ORDERS = ['chronological', 'speaker'] as const
export type TranscriptOrder = (typeof TRANSCRIPT_ORDERS)[number]

/** How a transcript export looks (T-43). Which speakers are shown is never stored. */
export const transcriptFormatFlagsSchema = z.object({
  speakers: z.boolean(),
  timestamps: z.boolean(),
  avatars: z.boolean(),
  bubbles: z.boolean(),
  anonymize: z.boolean(),
  order: z.enum(TRANSCRIPT_ORDERS)
})
export type TranscriptFormatFlags = z.infer<typeof transcriptFormatFlagsSchema>

/** kiChat's five built-in presets and their exact flags (T-44). */
export const TRANSCRIPT_PRESETS = {
  dialog_standard: {
    speakers: true,
    timestamps: true,
    avatars: true,
    bubbles: true,
    anonymize: false,
    order: 'chronological'
  },
  lesefassung: {
    speakers: true,
    timestamps: false,
    avatars: false,
    bubbles: false,
    anonymize: false,
    order: 'chronological'
  },
  zeitcodes: {
    speakers: false,
    timestamps: true,
    avatars: false,
    bubbles: false,
    anonymize: false,
    order: 'chronological'
  },
  sprecher_gruppiert: {
    speakers: true,
    timestamps: false,
    avatars: false,
    bubbles: false,
    anonymize: false,
    order: 'speaker'
  },
  fliesstext: {
    speakers: false,
    timestamps: false,
    avatars: false,
    bubbles: false,
    anonymize: false,
    order: 'chronological'
  }
} as const satisfies Record<string, TranscriptFormatFlags>
export type TranscriptPresetId = keyof typeof TRANSCRIPT_PRESETS
export const TRANSCRIPT_PRESET_IDS = Object.keys(TRANSCRIPT_PRESETS) as TranscriptPresetId[]
export const TRANSCRIPT_DEFAULT_PRESET: TranscriptPresetId = 'dialog_standard'

export const TRANSCRIPTION_FORMAT_NAME_MAX = 100

/** `POST TRANSCRIPTION_API.formats`: a new format (`id` null) or a change to one of the user's. */
export const transcriptionFormatInputSchema = transcriptFormatFlagsSchema.extend({
  id: z.uuid().nullable(),
  name: z.string().trim().min(1).max(TRANSCRIPTION_FORMAT_NAME_MAX)
})
export type TranscriptionFormatInput = z.infer<typeof transcriptionFormatInputSchema>

export const transcriptionFormatSchema = transcriptFormatFlagsSchema.extend({
  id: z.uuid(),
  name: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime()
})
export type TranscriptionFormat = z.infer<typeof transcriptionFormatSchema>

export const transcriptionFormatListSchema = z.object({
  formats: z.array(transcriptionFormatSchema)
})
export type TranscriptionFormatList = z.infer<typeof transcriptionFormatListSchema>

// ---------------------------------------------------------------------------
// Summary templates
// ---------------------------------------------------------------------------

export const TRANSCRIPTION_TEMPLATE_NAME_MAX = 255
export const TRANSCRIPTION_TEMPLATE_TEXT_MAX = 5000
export const TRANSCRIPTION_TEMPLATE_BLOCKS_MAX = 100
export const TRANSCRIPTION_TEMPLATE_ID_MAX = 100

/** A template's id: a built-in's slug (`interview`) or a user template's UUID. */
export const transcriptionTemplateIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(TRANSCRIPTION_TEMPLATE_ID_MAX)
  .regex(/^[\w-]+$/, 'Expected a template id')

/** The blocks of a summary template, in order (T-51). */
export const transcriptionTemplateBlockSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('heading'),
    level: z.literal([1, 2, 3]),
    text: z.string().max(TRANSCRIPTION_TEMPLATE_TEXT_MAX)
  }),
  z.object({ type: z.literal('text'), text: z.string().max(TRANSCRIPTION_TEMPLATE_TEXT_MAX) }),
  z.object({ type: z.literal('divider') }),
  z.object({
    type: z.literal('section'),
    /** Keys preview results; kiChat keyed them by heading, which need not be unique. */
    id: z.string().trim().min(1).max(64).optional(),
    heading: z.string().max(TRANSCRIPTION_TEMPLATE_TEXT_MAX),
    instruction: z.string().max(TRANSCRIPTION_TEMPLATE_TEXT_MAX)
  })
])
export type TranscriptionTemplateBlock = z.infer<typeof transcriptionTemplateBlockSchema>
export type TranscriptionTemplateSection = Extract<TranscriptionTemplateBlock, { type: 'section' }>

const templateStructureSchema = z
  .array(transcriptionTemplateBlockSchema)
  .max(TRANSCRIPTION_TEMPLATE_BLOCKS_MAX)

/** A summary template: a built-in (read-only for users) or one of the user's own (T-50, T-54). */
export const transcriptionTemplateSchema = z.object({
  id: transcriptionTemplateIdSchema,
  name: z.string(),
  description: z.string(),
  builtIn: z.boolean(),
  structure: templateStructureSchema,
  version: z.number().int().min(1),
  outputFormatHints: z.string().nullable(),
  createdAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime().nullable()
})
export type TranscriptionTemplate = z.infer<typeof transcriptionTemplateSchema>

/**
 * `POST TRANSCRIPTION_API.templates`: a new template (`id` null) or a change to one of the user's.
 * Names need not be unique (T-51). Built-ins cannot change (`403 forbidden`); copy them instead.
 */
export const transcriptionTemplateInputSchema = z.object({
  id: transcriptionTemplateIdSchema.nullable(),
  name: z.string().trim().min(1).max(TRANSCRIPTION_TEMPLATE_NAME_MAX),
  description: z.string().trim().max(TRANSCRIPTION_TEMPLATE_TEXT_MAX).default(''),
  structure: templateStructureSchema.min(1)
})
export type TranscriptionTemplateInput = z.input<typeof transcriptionTemplateInputSchema>

/** `GET TRANSCRIPTION_API.templates`: the built-ins, then the user's own. */
export const transcriptionTemplateListSchema = z.object({
  templates: z.array(transcriptionTemplateSchema)
})
export type TranscriptionTemplateList = z.infer<typeof transcriptionTemplateListSchema>

/** kiChat's five built-in templates, verbatim and German in either language (section 3, Q-12). */
export const TRANSCRIPTION_BUILTIN_TEMPLATES = [
  {
    id: 'focus-group',
    name: 'Fokusgruppe',
    description: 'Analyse von Gruppendiskussionen und Moderationsrunden.',
    structure: [
      { type: 'heading', level: 1, text: 'Fokusgruppe: {{title}}' },
      { type: 'text', text: 'Datum: {{date}} · Teilnehmer: {{participants}}' },
      {
        type: 'section',
        heading: 'Diskussion',
        instruction: 'Fasse den Verlauf der Diskussion und die verschiedenen Meinungen zusammen.'
      },
      {
        type: 'section',
        heading: 'Moderation',
        instruction: 'Analysiere die Rolle der Moderation und den Leitfaden.'
      },
      {
        type: 'section',
        heading: 'Kernthemen',
        instruction: 'Identifiziere die zentralen Themen und Erkenntnisse aus der Gruppenbefragung.'
      }
    ]
  },
  {
    id: 'interview',
    name: 'Interview',
    description: 'Auswertung von Einzelinterviews mit Fokus auf Zitate und Themen.',
    structure: [
      { type: 'heading', level: 1, text: 'Interview: {{title}}' },
      { type: 'text', text: 'Datum: {{date}} · Teilnehmer: {{participants}}' },
      {
        type: 'section',
        heading: 'Kernaussagen',
        instruction: 'Fasse die Hauptthemen und wichtigsten Kernaussagen des Interviews zusammen.'
      },
      {
        type: 'section',
        heading: 'Zitate',
        instruction: 'Extrahiere besonders prägnante und repräsentative Zitate aus dem Gespräch.'
      },
      {
        type: 'section',
        heading: 'Themen',
        instruction: 'Gliedere das Gespräch in die behandelten Themenschwerpunkte.'
      }
    ]
  },
  {
    id: 'meeting-protocol',
    name: 'Meeting-Protokoll',
    description: 'Strukturiertes Protokoll für Meetings und Teambesprechungen.',
    structure: [
      { type: 'heading', level: 1, text: 'Meeting-Protokoll: {{title}}' },
      { type: 'text', text: 'Datum: {{date}} · Dauer: {{duration}}' },
      { type: 'text', text: 'Teilnehmer: {{participants}}' },
      {
        type: 'section',
        heading: 'Ergebnisse',
        instruction: 'Fasse die wichtigsten Ergebnisse des Meetings zusammen.'
      },
      {
        type: 'section',
        heading: 'Beschlüsse',
        instruction: 'Liste alle getroffenen Beschlüsse und Vereinbarungen als Stichpunkte.'
      },
      {
        type: 'section',
        heading: 'To-dos',
        instruction: 'Erstelle eine To-do-Liste mit Aufgaben, Zuständigkeiten und Fristen.'
      }
    ]
  },
  {
    id: 'mein-interview-format',
    name: 'Mein Interview-Format',
    description: 'Benutzerdefiniertes Format für strukturierte Interviews.',
    structure: [
      { type: 'heading', level: 1, text: '{{title}}' },
      { type: 'text', text: 'Datum: {{date}} · {{participants}}' },
      {
        type: 'section',
        heading: 'Zusammenfassung',
        instruction: 'Fasse das Gespräch in 3–4 Sätzen zusammen.'
      },
      {
        type: 'section',
        heading: 'Wichtigste Entscheidungen',
        instruction: 'Liste alle Entscheidungen als Stichpunkte.'
      },
      {
        type: 'section',
        heading: 'Offene Aufgaben',
        instruction: 'Extrahiere To-dos mit verantwortlicher Person.'
      }
    ]
  },
  {
    id: 'legacy',
    name: 'Standard-Protokoll',
    description: 'Das standardmäßige HAWKI-Ergebnisprotokoll.',
    structure: [
      {
        type: 'section',
        heading: '',
        instruction:
          'Du bist ein Experte für Gesprächsprotokolle. Hier ist das Transkript eines Gesprächs. Erstelle ein professionelles Ergebnisprotokoll.\n\nStruktur:\n1. Titel/Thema (basierend auf dem Inhalt)\n2. Zusammenfassung (kurz und prägnant)\n3. Wichtigste Kernaussagen (als Stichpunkte)\n4. Beschlüsse und nächste Schritte (falls identifizierbar)\n\nSprache: Deutsch. Form: Professionell, sachlich.'
      }
    ]
  }
] as const satisfies ReadonlyArray<{
  id: string
  name: string
  description: string
  structure: readonly TranscriptionTemplateBlock[]
}>
export type TranscriptionBuiltInTemplateId = (typeof TRANSCRIPTION_BUILTIN_TEMPLATES)[number]['id']
/** The template a summary uses until the user picks another. */
export const TRANSCRIPTION_DEFAULT_TEMPLATE_ID: TranscriptionBuiltInTemplateId = 'legacy'

/** The four placeholders and the German aliases kiChat also replaces (T-52). */
export const TRANSCRIPTION_TEMPLATE_PLACEHOLDERS = {
  title: ['{{title}}', '{{titel}}'],
  date: ['{{date}}', '{{datum}}'],
  participants: ['{{participants}}', '{{teilnehmer}}'],
  duration: ['{{duration}}', '{{dauer}}']
} as const
export type TranscriptionPlaceholder = keyof typeof TRANSCRIPTION_TEMPLATE_PLACEHOLDERS

/** Replaces every placeholder, alias included, with its value. */
export function fillTemplatePlaceholders(
  text: string,
  values: Record<TranscriptionPlaceholder, string>
): string {
  let result = text
  for (const [key, tokens] of Object.entries(TRANSCRIPTION_TEMPLATE_PLACEHOLDERS)) {
    for (const token of tokens) {
      result = result.replaceAll(token, values[key as TranscriptionPlaceholder])
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

/** Text an unsaved transcript may send for a summary. */
export const TRANSCRIPTION_SUMMARY_TEXT_MAX = 2_000_000
export const TRANSCRIPTION_PREVIEW_SECTIONS_MAX = 20

const summarySourceFields = {
  /** A saved transcript of the user's; the server assembles its text. */
  transcriptId: z.uuid().nullable().default(null),
  /** Or the text itself, redactions applied, for an unsaved one. */
  transcriptText: z.string().max(TRANSCRIPTION_SUMMARY_TEXT_MAX).nullable().default(null),
  /** One of `llmModels`; `null`: `defaultSummaryModel`. */
  model: z.string().trim().min(1).max(200).nullable().default(null)
}

const hasSummarySource = (input: {
  transcriptId: string | null
  transcriptText: string | null
}): boolean => input.transcriptId !== null || Boolean(input.transcriptText?.trim())

/**
 * `POST TRANSCRIPTION_API.summaries` (T-48, T-49): `checkOnly` only looks up a stored summary,
 * `forceRegenerate` never uses one. Stored summaries are keyed by transcript revision, template
 * version and model, so an edit makes them stale.
 */
export const transcriptionSummaryRequestSchema = z
  .object({
    ...summarySourceFields,
    templateId: transcriptionTemplateIdSchema,
    forceRegenerate: z.boolean().default(false),
    checkOnly: z.boolean().default(false)
  })
  .refine(hasSummarySource, { message: 'Name a transcript or send its text' })
export type TranscriptionSummaryRequest = z.input<typeof transcriptionSummaryRequestSchema>

export const transcriptionSummarySchema = z.object({
  /** The finished summary as Markdown. */
  markdown: z.string(),
  templateId: z.string(),
  templateVersion: z.number().int().min(1),
  /** The transcript revision it was made from; `null` for unsaved text. */
  transcriptRevision: z.number().int().min(1).nullable(),
  /**
   * The saved transcript's title `{{title}}` was filled with; `null` for unsaved text. A generated
   * title replaces the default one without a new revision.
   */
  transcriptTitle: z.string().nullable(),
  model: z.string().nullable(),
  generatedAt: z.iso.datetime(),
  /** Whether it came from the store rather than the model just now. */
  cached: z.boolean()
})
export type TranscriptionSummary = z.infer<typeof transcriptionSummarySchema>

/** `null` only for `checkOnly` when nothing is stored. */
export const transcriptionSummaryResponseSchema = z.object({
  summary: transcriptionSummarySchema.nullable()
})
export type TranscriptionSummaryResponse = z.infer<typeof transcriptionSummaryResponseSchema>

/** One AI section to try out in the template editor. */
export const transcriptionPreviewSectionSchema = z.object({
  id: z.string().trim().min(1).max(64),
  heading: z.string().max(TRANSCRIPTION_TEMPLATE_TEXT_MAX),
  instruction: z.string().trim().min(1).max(TRANSCRIPTION_TEMPLATE_TEXT_MAX)
})
export type TranscriptionPreviewSection = z.infer<typeof transcriptionPreviewSectionSchema>

/**
 * `POST TRANSCRIPTION_API.summaryPreview` (T-53): generates only the sections sent, on an excerpt
 * of the transcript. `staleSectionIds` names those whose instruction changed since the last run.
 */
export const transcriptionSummaryPreviewRequestSchema = z
  .object({
    ...summarySourceFields,
    sections: z
      .array(transcriptionPreviewSectionSchema)
      .min(1)
      .max(TRANSCRIPTION_PREVIEW_SECTIONS_MAX)
      .refine(
        (sections) => new Set(sections.map((section) => section.id)).size === sections.length,
        {
          message: 'Section ids must be unique'
        }
      ),
    staleSectionIds: z.array(z.string().max(64)).max(TRANSCRIPTION_PREVIEW_SECTIONS_MAX).default([])
  })
  .refine(hasSummarySource, { message: 'Name a transcript or send its text' })
export type TranscriptionSummaryPreviewRequest = z.input<
  typeof transcriptionSummaryPreviewRequestSchema
>

/** Markdown per section id; sections that failed appear in `errors` instead. */
export const transcriptionSummaryPreviewSchema = z.object({
  results: z.record(z.string(), z.string()),
  errors: z.record(z.string(), z.string()).default({})
})
export type TranscriptionSummaryPreview = z.infer<typeof transcriptionSummaryPreviewSchema>

// ---------------------------------------------------------------------------
// AI speaker optimisation
// ---------------------------------------------------------------------------

/**
 * `POST TRANSCRIPTION_API.speakerOptimization` (T-36): the chat model reassigns speakers. Text and
 * timing stay; the answer replaces the segments, which the client saves as an undoable change.
 */
export const transcriptionSpeakerOptimizationRequestSchema = z.object({
  segments: transcriptionSegmentsSchema.refine((segments) => segments.length > 0, {
    message: 'Send at least one segment'
  }),
  transcriptId: z.uuid().nullable().default(null),
  model: z.string().trim().min(1).max(200).nullable().default(null)
})
export type TranscriptionSpeakerOptimizationRequest = z.input<
  typeof transcriptionSpeakerOptimizationRequestSchema
>

export const transcriptionSpeakerOptimizationSchema = z.object({
  segments: z.array(transcriptionSegmentSchema)
})
export type TranscriptionSpeakerOptimization = z.infer<
  typeof transcriptionSpeakerOptimizationSchema
>

// ---------------------------------------------------------------------------
// Live transcription
// ---------------------------------------------------------------------------

/**
 * `onprem`: the gateway's realtime WebSocket (vLLM's Voxtral behind the HRZ LiteLLM gateway);
 * `openai`: OpenAI Realtime. Both run through the Campus server (`TRANSCRIPTION_API.realtimeLive`),
 * which holds the keys; the browser only ever talks to its own API origin.
 */
export const TRANSCRIPTION_REALTIME_MODES = ['onprem', 'openai'] as const
export const transcriptionRealtimeModeSchema = z.enum(TRANSCRIPTION_REALTIME_MODES)
export type TranscriptionRealtimeMode = z.infer<typeof transcriptionRealtimeModeSchema>

/**
 * The audio each mode takes, as the browser sends it: 16-bit little-endian PCM, mono, at this
 * rate. vLLM's realtime endpoint wants 16 kHz (as kiChat's bridge resampled to), OpenAI's
 * transcription sessions `audio/pcm` at 24 kHz.
 */
export const TRANSCRIPTION_REALTIME_SAMPLE_RATES: Record<TranscriptionRealtimeMode, number> = {
  onprem: 16_000,
  openai: 24_000
}

/** The browser sends audio in frames of this length. */
export const TRANSCRIPTION_LIVE_FRAME_MS = 100

/**
 * Bounds of the live WebSocket: one `input_audio_buffer.append` carries at most a second of audio
 * (`TRANSCRIPTION_LIVE_APPEND_MAX_MS`), one message of the browser at most
 * `TRANSCRIPTION_LIVE_MESSAGE_MAX_BYTES`; the server closes a socket that sends more.
 */
export const TRANSCRIPTION_LIVE_APPEND_MAX_MS = 1000
export const TRANSCRIPTION_LIVE_MESSAGE_MAX_BYTES = 96 * 1024

/**
 * Why live transcription cannot run with a mode: the gateway refused the realtime model for its
 * key (it takes the key otherwise), refused the key, refused the session otherwise, or the server
 * cannot reach it.
 */
export const TRANSCRIPTION_REALTIME_UNAVAILABLE_REASONS = [
  'modelNotAllowed',
  'gatewayKeyRejected',
  'gatewayRefused',
  'gatewayUnreachable'
] as const
export type TranscriptionRealtimeUnavailableReason =
  (typeof TRANSCRIPTION_REALTIME_UNAVAILABLE_REASONS)[number]

/**
 * The codes of the server's `error` events on the live WebSocket, which the web app words itself;
 * the server never passes on what an upstream said. Before the session is ready: the mode is not
 * set up (`not_set_up`), the server or the user holds as many sessions as allowed (`busy`), or the
 * gateway refused or is unreachable (`model_not_allowed`, `gateway_key_rejected`,
 * `gateway_refused`, `gateway_unreachable`). While it runs: the gateway reported an error or
 * closed its stream (`upstream_error`, `upstream_closed`), no audio came for too long
 * (`session_idle`), the session reached its maximum length (`session_expired`), the browser sent
 * something the server does not take (`invalid_event`), more audio than real time
 * (`audio_rate_exceeded`) or more messages or bytes than the server takes
 * (`message_rate_exceeded`).
 */
export const TRANSCRIPTION_LIVE_ERROR_CODES = [
  'not_set_up',
  'busy',
  'model_not_allowed',
  'gateway_key_rejected',
  'gateway_refused',
  'gateway_unreachable',
  'upstream_error',
  'upstream_closed',
  'session_idle',
  'session_expired',
  'invalid_event',
  'audio_rate_exceeded',
  'message_rate_exceeded'
] as const
export type TranscriptionLiveErrorCode = (typeof TRANSCRIPTION_LIVE_ERROR_CODES)[number]

export function isTranscriptionLiveErrorCode(value: string): value is TranscriptionLiveErrorCode {
  return (TRANSCRIPTION_LIVE_ERROR_CODES as readonly string[]).includes(value)
}

/** The live error code of an unavailable reason. */
export const TRANSCRIPTION_LIVE_UNAVAILABLE_CODES: Record<
  TranscriptionRealtimeUnavailableReason,
  TranscriptionLiveErrorCode
> = {
  modelNotAllowed: 'model_not_allowed',
  gatewayKeyRejected: 'gateway_key_rejected',
  gatewayRefused: 'gateway_refused',
  gatewayUnreachable: 'gateway_unreachable'
}

/** The default model of the on-prem path: vLLM's Voxtral realtime behind the gateway, as kiChat. */
export const TRANSCRIPTION_DEFAULT_REALTIME_MODEL = 'voxtral-mini-realtime'

/** `GET TRANSCRIPTION_API.realtimeConfig` (T-59): the modes that are set up. */
export const transcriptionRealtimeConfigSchema = z.object({
  modes: z.array(transcriptionRealtimeModeSchema),
  /** The admin's default if offered, else the first mode; `null` without modes. */
  defaultMode: transcriptionRealtimeModeSchema.nullable(),
  /**
   * Why the on-prem mode is set up but cannot run right now, as the server's probe of the gateway
   * found (`modes` leaves it out then); `null` while it works or is not set up.
   */
  onpremUnavailable: z
    .object({ reason: z.enum(TRANSCRIPTION_REALTIME_UNAVAILABLE_REASONS), model: z.string() })
    .nullable()
    .default(null)
})
export type TranscriptionRealtimeConfig = z.infer<typeof transcriptionRealtimeConfigSchema>

// ---------------------------------------------------------------------------
// Admin configuration
// ---------------------------------------------------------------------------

/**
 * A model of an OpenAI-compatible endpoint: `id` as the endpoint takes it, `label` for users.
 * `speech`: model discovery (`Modelle abrufen`) classified it as speech recognition (LiteLLM's
 * `audio_transcription` mode, else its id); left out for models typed by hand and chat models.
 */
export const transcriptionModelSchema = z.object({
  id: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(80),
  speech: z.literal(true).optional()
})
export type TranscriptionModel = z.infer<typeof transcriptionModelSchema>

export const TRANSCRIPTION_MODELS_MAX = 20

/** Speech synthesis, which shares words such as `speech` with recognition. */
const SPEECH_SYNTHESIS_ID = /(^|[^a-z])tts([^a-z]|$)|text[-_ ]?to[-_ ]?speech/i
/** Speech recognition models by id: Whisper, `…-transcribe`, STT/ASR, Voxtral, Parakeet, Canary. */
const SPEECH_RECOGNITION_ID =
  /whisper|transcri|speech|(^|[^a-z])(stt|asr)([^a-z]|$)|voxtral|parakeet|canary|wav2vec|seamless|moonshine/i

/** Whether a model id names a speech recognition model, as far as its id tells. */
export function isSpeechModelId(id: string): boolean {
  return !SPEECH_SYNTHESIS_ID.test(id) && SPEECH_RECOGNITION_ID.test(id)
}

/**
 * The speech model used without a default, in the list's order: the first that discovery
 * classified as speech recognition (`speech`) or whose id names a speech model, so the first
 * model discovery found stays the one used, whatever its id, and a chat model listed before a
 * speech model (a list saved before discovery classified) is passed over. Without either the
 * first model is used: an id the admin typed is their choice, so this may still be a chat model
 * typed into the speech list.
 */
export function firstSpeechModel<T extends { id: string; speech?: true }>(
  models: readonly T[]
): T | null {
  const named = models.filter((model) => model.id.trim())
  return (
    named.find((model) => model.speech === true || isSpeechModelId(model.id)) ?? named[0] ?? null
  )
}

const modelListSchema = z
  .array(transcriptionModelSchema)
  .max(TRANSCRIPTION_MODELS_MAX)
  .refine((models) => new Set(models.map((model) => model.id)).size === models.length, {
    message: 'Model ids must be unique'
  })
  .default([])

/** The HRZ's LiteLLM gateway (KI@JLU), up to `/v1`: speech and chat models of the university. */
export const TRANSCRIPTION_HRZ_API_URL = 'https://api.hrz.uni-giessen.de/v1'
/** The gateway's chat model for summaries and section previews. */
export const TRANSCRIPTION_DEFAULT_SUMMARY_MODEL = 'jlu/qwen3.8-27b'
/** The gateway's quicker chat model for correction, speaker optimisation, title and subtitle. */
export const TRANSCRIPTION_DEFAULT_FAST_MODEL = 'jlu/qwen3.8-27b-fast'
/** The gateway's speech model (Whisper large v3), as kiChat's batch transcription uses it. */
export const TRANSCRIPTION_DEFAULT_ASR_MODEL = 'jlu/whisper-1'
/** kiChat's diarisation model on its Speaches server. */
export const TRANSCRIPTION_DEFAULT_DIARIZATION_MODEL = 'pyannote/speaker-diarization-community-1'

/**
 * One or more OpenAI-compatible speech workers up to `/v1`, comma-separated as kiChat's
 * `base_url`: the chunks of a job go to them in turn.
 */
export const transcriptionUrlListSchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine(
    (value) => {
      const urls = value.split(',').map((part) => part.trim())
      return urls.length <= 10 && urls.every((url) => httpsUrlSchema.safeParse(url).success)
    },
    { message: 'Expected up to ten comma-separated URLs (https, http only for localhost)' }
  )

/** The URLs of a comma-separated list, trimmed, without empty entries. */
export function transcriptionUrls(value: string | null | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

/**
 * The module's settings. Every upstream is optional, so a stored config of an older release
 * parses; what is missing turns the matching capability off (`transcriptionCapabilitiesSchema`).
 * Keys this schema no longer knows are dropped when it parses, such as the realtime bridge and ICE
 * servers of the WebRTC releases (`onpremSignalingUrl`, `realtimeIceServers`, `realtimeTurnAuth`,
 * `realtimeTurnCredentialSeconds`).
 */
export const transcriptionComponentConfigSchema = z.object({
  /**
   * OpenAI-compatible speech endpoint up to `/v1` (`POST /audio/transcriptions`), the HRZ gateway
   * unless the admin names another; several workers comma-separated (kiChat's `base_url`).
   */
  asrBaseUrl: transcriptionUrlListSchema.nullable().default(TRANSCRIPTION_HRZ_API_URL),
  asrModels: modelListSchema,
  /**
   * One of `asrModels`; `null`: the first speech model of the list (`firstSpeechModel`). kiChat's model on the gateway, used once `asrModels`
   * lists it (`Modelle abrufen`, which needs the key).
   */
  defaultAsrModel: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .nullable()
    .default(TRANSCRIPTION_DEFAULT_ASR_MODEL),
  /**
   * Requests in flight at the speech and diarisation servers at once, across all jobs and chunks
   * of this server process (kiChat's `SPEACHES_MAX_CONCURRENCY`): the servers' model instances.
   */
  asrConcurrency: z.number().int().min(1).max(32).default(3),
  /** Provider name saved with transcripts and shown in the admin form, e.g. `KI@JLU`. */
  providerName: z.string().trim().min(1).max(80).nullable().default(null),
  /**
   * Speaker analysis and diarisation; off gives every file one automatic voice (and says so in
   * the capabilities).
   */
  diarizationEnabled: z.boolean().default(false),
  /**
   * The Speaches diarisation server up to `/v1` (`POST /audio/diarization`,
   * `POST /audio/speech/timestamps`), as kiChat's `diarization_base_url`; `null`: the speech
   * endpoint (its first worker). Its key is `diarizationApiKey`, else the speech key.
   */
  diarizationUrl: httpsUrlSchema.nullable().default(null),
  /** The pyannote model the diariser runs; `null`: kiChat's default. */
  diarizationModel: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .nullable()
    .default(TRANSCRIPTION_DEFAULT_DIARIZATION_MODEL),
  /**
   * OpenAI-compatible chat endpoint up to `/v1`, for correction, summaries and optimisation; the
   * HRZ gateway unless the admin names another. Chat stays off until `llmModels` lists a model.
   */
  llmBaseUrl: httpsUrlSchema.nullable().default(TRANSCRIPTION_HRZ_API_URL),
  llmModels: modelListSchema,
  /**
   * The model of the quick tasks: LLM correction, speaker optimisation, title and subtitle. Used
   * once `llmModels` lists it (`Modelle abrufen`).
   */
  defaultCorrectionModel: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .nullable()
    .default(TRANSCRIPTION_DEFAULT_FAST_MODEL),
  /** The model of summaries and section previews, once `llmModels` lists it. */
  defaultSummaryModel: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .nullable()
    .default(TRANSCRIPTION_DEFAULT_SUMMARY_MODEL),
  /**
   * Sends `chat_template_kwargs: {enable_thinking: false}`, which vLLM servers with Qwen3 models
   * (the HRZ gateway) understand: they answer at once instead of reasoning first. Off for endpoints
   * that refuse unknown parameters, such as OpenAI's.
   */
  llmDisableThinking: z.boolean().default(true),
  defaultLanguage: transcriptionLanguageSchema.default('auto'),
  defaultSpeakerCount: transcriptionSpeakerCountSchema.default('auto'),
  defaultLlmCorrection: z.boolean().default(true),
  maxFileBytes: z
    .number()
    .int()
    .min(1024 * 1024)
    .max(10 * 1024 * 1024 * 1024)
    .default(TRANSCRIPTION_MAX_FILE_BYTES),
  /** `null`: no limit beyond the file size. */
  maxDurationSeconds: z
    .number()
    .int()
    .min(60)
    .max(TRANSCRIPTION_SECONDS_MAX)
    .nullable()
    .default(null),
  maxFilesPerGroup: z
    .number()
    .int()
    .min(1)
    .max(TRANSCRIPTION_GROUP_FILES_MAX)
    .nullable()
    .default(null),
  /** Jobs a user may have uploading, analysing or transcribing at once. */
  maxActiveJobsPerUser: z.number().int().min(1).max(1000).default(20),
  /** Jobs the worker processes at once in this server process. */
  workerConcurrency: z.number().int().min(1).max(16).default(2),
  /** Length of the chunks long audio is cut into before recognition. */
  chunkSeconds: z.number().int().min(30).max(3600).default(600),
  /** How long one upstream request may take. */
  upstreamTimeoutSeconds: z.number().int().min(10).max(3600).default(600),
  /** Saved transcripts are deleted this long after their last change; `null`: kept until deleted. */
  transcriptRetentionHours: z.number().int().min(1).max(87_600).nullable().default(null),
  /** Unsaved, failed and cancelled jobs and their audio are deleted after this. */
  unsavedJobRetentionHours: z
    .number()
    .int()
    .min(1)
    .max(720)
    .default(TRANSCRIPTION_UNSAVED_JOB_TTL_HOURS),
  realtimeModes: z
    .array(transcriptionRealtimeModeSchema)
    .max(TRANSCRIPTION_REALTIME_MODES.length)
    .refine((modes) => new Set(modes).size === modes.length, { message: 'Modes must be unique' })
    .default([]),
  defaultRealtimeMode: transcriptionRealtimeModeSchema.nullable().default(null),
  /**
   * The gateway of the on-prem live mode, up to `/v1`: the server opens `wss://…/v1/realtime` there
   * with the speech key; `null`: the speech endpoint (its first worker).
   */
  onpremGatewayUrl: httpsUrlSchema.nullable().default(null),
  /** The gateway's realtime model for the on-prem path. */
  onpremRealtimeModel: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .default(TRANSCRIPTION_DEFAULT_REALTIME_MODEL),
  /**
   * OpenAI's API up to `/v1`: the server opens its realtime WebSocket below it
   * (`wss://…/v1/realtime?intent=transcription`) with the admin's key.
   */
  openaiRealtimeUrl: httpsUrlSchema.default('https://api.openai.com/v1'),
  openaiRealtimeModel: z.string().trim().min(1).max(200).default('gpt-realtime-whisper')
})
export type TranscriptionComponentConfig = z.infer<typeof transcriptionComponentConfigSchema>

/** A fresh module's settings: nothing connected yet. */
export const TRANSCRIPTION_DEFAULT_CONFIG: TranscriptionComponentConfig =
  transcriptionComponentConfigSchema.parse({})

/** The module's secrets (`COMPONENT_SECRETS.transcription`), each encrypted on the server. */
export const TRANSCRIPTION_SECRET_KEYS = [
  'apiKey',
  'diarizationApiKey',
  'llmApiKey',
  'openaiRealtimeApiKey'
] as const
export type TranscriptionSecretKey = (typeof TRANSCRIPTION_SECRET_KEYS)[number]

/** What the module offers right now, for the web app to show only what works. */
export const transcriptionCapabilitiesSchema = z.object({
  /** Upload and transcription: speech endpoint, a model and storage are set up. */
  batch: z.boolean(),
  /** Speaker analysis and naming. */
  diarization: z.boolean(),
  /** The upload option to correct the text with the chat model. */
  llmCorrection: z.boolean(),
  summaries: z.boolean(),
  speakerOptimization: z.boolean(),
  realtimeModes: z.array(transcriptionRealtimeModeSchema),
  defaultRealtimeMode: transcriptionRealtimeModeSchema.nullable(),
  /** The speech model jobs use. */
  asrModel: transcriptionModelSchema.nullable(),
  provider: z.string().nullable(),
  /** Models a summary may choose. */
  summaryModels: z.array(transcriptionModelSchema),
  defaultSummaryModel: z.string().nullable(),
  defaults: transcriptionJobSettingsSchema,
  limits: z.object({
    maxFileBytes: z.number().int().positive(),
    maxDurationSeconds: z.number().int().positive().nullable(),
    maxFilesPerGroup: z.number().int().positive().nullable(),
    maxActiveJobs: z.number().int().positive()
  }),
  retention: z.object({
    /** `null`: saved transcripts stay until the user deletes them. */
    transcriptHours: z.number().int().positive().nullable(),
    unsavedJobHours: z.number().int().positive()
  })
})
export type TranscriptionCapabilities = z.infer<typeof transcriptionCapabilitiesSchema>

/** Which endpoint `POST TRANSCRIPTION_API.adminModels` asks. */
export const TRANSCRIPTION_MODEL_KINDS = ['asr', 'llm'] as const
export type TranscriptionModelKind = (typeof TRANSCRIPTION_MODEL_KINDS)[number]

/**
 * Lists an endpoint's models for the admin form. `apiKey` as typed in the form: a string uses it,
 * `null` sends none, left out uses the saved key of that endpoint.
 */
export const transcriptionModelsRequestSchema = z.object({
  kind: z.enum(TRANSCRIPTION_MODEL_KINDS),
  baseUrl: httpsUrlSchema,
  apiKey: z.string().trim().min(1).max(SECRET_VALUE_MAX).nullable().optional()
})
export type TranscriptionModelsRequest = z.infer<typeof transcriptionModelsRequestSchema>

/**
 * The endpoint's models of the kind asked for, in its order: speech recognition models for `asr`
 * (LiteLLM's `mode: audio_transcription` where the endpoint says, else by id), chat models for
 * `llm`. `leftOut` counts the endpoint's other models; the admin may still add any id by hand.
 */
export const transcriptionModelListSchema = z.object({
  models: z.array(transcriptionModelSchema),
  leftOut: z.number().int().min(0).default(0)
})
export type TranscriptionModelList = z.infer<typeof transcriptionModelListSchema>

export const TRANSCRIPTION_CONNECTION_TARGETS = [
  'asr',
  'diarization',
  'llm',
  'realtimeOnprem',
  'realtimeOpenai',
  'storage'
] as const
export type TranscriptionConnectionTarget = (typeof TRANSCRIPTION_CONNECTION_TARGETS)[number]

/**
 * `POST TRANSCRIPTION_API.adminTest`: checks one upstream with the values typed in the form, or
 * the saved ones where left out (`apiKey` as for models). Keys never come back.
 */
export const transcriptionConnectionTestRequestSchema = z.object({
  target: z.enum(TRANSCRIPTION_CONNECTION_TARGETS),
  url: httpsUrlSchema.optional(),
  apiKey: z.string().trim().min(1).max(SECRET_VALUE_MAX).nullable().optional(),
  model: z.string().trim().min(1).max(200).optional(),
  /** `llm` only: `llmDisableThinking` as set in the form; left out uses the saved one. */
  disableThinking: z.boolean().optional(),
  /** `realtimeOnprem` only: `onpremGatewayUrl` as typed; `null` uses the speech endpoint. */
  gatewayUrl: httpsUrlSchema.nullable().optional()
})
export type TranscriptionConnectionTestRequest = z.infer<
  typeof transcriptionConnectionTestRequestSchema
>

/** What an operational check expected and did not get. */
export const TRANSCRIPTION_CONNECTION_ANSWERS = [
  'transcription',
  'diarization',
  'chat',
  'storedContent'
] as const

/**
 * What the server found itself, for the web to say in the admin's language: the number of models
 * listed, a chosen model the endpoint does not list, an upstream not set up, a reachable bucket,
 * and what an operational check did (a test clip transcribed or diarised, a chat answer, a realtime
 * session the gateway took, a stored object read back and deleted) or found wrong with the answer.
 */
export const transcriptionConnectionFindingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('models'), count: z.number().int().min(0) }),
  z.object({ kind: z.literal('modelMissing'), model: z.string() }),
  z.object({ kind: z.literal('notSetUp') }),
  z.object({ kind: z.literal('bucketReachable'), bucket: z.string() }),
  z.object({ kind: z.literal('modelsUnlisted') }),
  z.object({ kind: z.literal('noModel') }),
  z.object({ kind: z.literal('transcribed'), model: z.string() }),
  z.object({ kind: z.literal('diarized'), turns: z.number().int().min(0) }),
  z.object({ kind: z.literal('chatAnswered'), model: z.string() }),
  z.object({ kind: z.literal('realtimeModelAccepted'), model: z.string() }),
  z.object({
    kind: z.literal('realtimeUnavailable'),
    reason: z.enum(TRANSCRIPTION_REALTIME_UNAVAILABLE_REASONS),
    model: z.string()
  }),
  z.object({ kind: z.literal('signedRoundTrip'), bucket: z.string() }),
  z.object({ kind: z.literal('serverRoundTrip'), bucket: z.string() }),
  z.object({ kind: z.literal('signedUrlsUnreachable') }),
  z.object({
    kind: z.literal('invalidAnswer'),
    expected: z.enum(TRANSCRIPTION_CONNECTION_ANSWERS)
  })
])
export type TranscriptionConnectionFinding = z.infer<typeof transcriptionConnectionFindingSchema>

export const transcriptionConnectionTestSchema = z.object({
  ok: z.boolean(),
  /** The upstream's HTTP status, if it answered. */
  status: z.number().int().nullable(),
  latencyMs: z.number().int().min(0).nullable(),
  finding: transcriptionConnectionFindingSchema.nullable(),
  /** Every step checked, in order; `finding` is the one that decided. */
  checks: z.array(transcriptionConnectionFindingSchema).default([]),
  /** The upstream's own detail, e.g. its error body; never a credential. */
  message: z.string().nullable()
})
export type TranscriptionConnectionTest = z.infer<typeof transcriptionConnectionTestSchema>

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const MODULE = '/api/modules/transcription'
const ADMIN = '/api/admin/modules/transcription'

/**
 * The module's endpoints (`API.module('transcription')` and `API.adminModule('transcription')`).
 * Every route needs a session and acts on the signed-in user's data only; another user's job,
 * transcript, format or template answers `404 not_found`, like a missing one. While the module is
 * disabled its user routes answer `404 not_found`. Errors use the API's error shape: bad input
 * `400 validation`, a changed revision `409 conflict`, too many active jobs `429 rate_limited`, a
 * capability that is not set up or an upstream failure `502 module_unavailable`.
 */
export const TRANSCRIPTION_API = {
  /** GET: `transcriptionCapabilitiesSchema`. */
  capabilities: `${MODULE}/capabilities`,
  /**
   * GET: `transcriptionJobListSchema`. POST: `transcriptionJobCreateSchema` → 201
   * `transcriptionJobCreatedSchema`; a file over `maxFileBytes` answers `400 validation`.
   */
  jobs: `${MODULE}/jobs`,
  /** GET: `transcriptionJobSchema` with `result` once completed. DELETE → 204, also when gone. */
  job: (id: string) => `${MODULE}/jobs/${id}`,
  /**
   * POST `transcriptionAnalyzeSchema` → `transcriptionJobSchema`: checks the uploaded bytes and
   * queues the speaker analysis; again after `analyzed` or `failed` it repeats it (T-21).
   */
  jobAnalyze: (id: string) => `${MODULE}/jobs/${id}/analyze`,
  /** POST `transcriptionDispatchSchema` → `transcriptionJobSchema`; a second dispatch `409 conflict`. */
  jobDispatch: (id: string) => `${MODULE}/jobs/${id}/dispatch`,
  /** GET: `transcriptionMediaUrlSchema` for the uploaded audio. */
  jobAudio: (id: string) => `${MODULE}/jobs/${id}/audio`,
  /** GET: `transcriptionJobPeaksSchema` once analysed; `404` before or without a waveform. */
  jobPeaks: (id: string) => `${MODULE}/jobs/${id}/peaks`,
  /** GET: `transcriptionMediaUrlSchema` for one analysed voice sample. */
  jobSample: (id: string, sampleId: string) =>
    `${MODULE}/jobs/${id}/samples/${encodeURIComponent(sampleId)}`,
  /**
   * GET: `transcriptionTranscriptListSchema`. POST: `transcriptionTranscriptCreateSchema` → 201
   * `transcriptionTranscriptSchema` (200 when the idempotency key was used before).
   */
  transcripts: `${MODULE}/transcripts`,
  /**
   * GET: `transcriptionTranscriptSchema`. PATCH: `transcriptionTranscriptPatchSchema` →
   * `transcriptionTranscriptSchema`. DELETE → 204.
   */
  transcript: (id: string) => `${MODULE}/transcripts/${id}`,
  /** POST → `transcriptionTranscriptSchema`: the chat model writes a new subtitle (source `ai`). */
  transcriptSubtitle: (id: string) => `${MODULE}/transcripts/${id}/subtitle`,
  /** GET: `transcriptionFormatListSchema`. POST: `transcriptionFormatInputSchema` → `transcriptionFormatSchema`. */
  formats: `${MODULE}/formats`,
  /** DELETE → 204. */
  format: (id: string) => `${MODULE}/formats/${id}`,
  /** GET: `transcriptionTemplateListSchema`. POST: `transcriptionTemplateInputSchema` → `transcriptionTemplateSchema`. */
  templates: `${MODULE}/templates`,
  /** DELETE → 204; a built-in answers `403 forbidden`. */
  template: (id: string) => `${MODULE}/templates/${encodeURIComponent(id)}`,
  /** POST `transcriptionSummaryRequestSchema` → `transcriptionSummaryResponseSchema`. */
  summaries: `${MODULE}/summaries`,
  /** POST `transcriptionSummaryPreviewRequestSchema` → `transcriptionSummaryPreviewSchema`. */
  summaryPreview: `${MODULE}/summaries/preview`,
  /** POST `transcriptionSpeakerOptimizationRequestSchema` → `transcriptionSpeakerOptimizationSchema`. */
  speakerOptimization: `${MODULE}/speaker-optimization`,
  /** GET: `transcriptionRealtimeConfigSchema`. */
  realtimeConfig: `${MODULE}/realtime/config`,
  /**
   * WebSocket (`?mode=onprem|openai`): one live session. The browser sends
   * `input_audio_buffer.append` (base64 PCM16 at the mode's `TRANSCRIPTION_REALTIME_SAMPLE_RATES`)
   * and `input_audio_buffer.commit` (`keep_open` to go on with a new item), and gets OpenAI realtime
   * transcription events (`session.created` once the gateway took the session,
   * `input_audio_buffer.committed`, `conversation.item.input_audio_transcription.delta`,
   * `…completed`, `…failed`, `error` with a `TRANSCRIPTION_LIVE_ERROR_CODES` code).
   */
  realtimeLive: `${MODULE}/live`,
  /** Admin only. POST `transcriptionModelsRequestSchema` → `transcriptionModelListSchema`. */
  adminModels: `${ADMIN}/models`,
  /** Admin only. POST `transcriptionConnectionTestRequestSchema` → `transcriptionConnectionTestSchema`. */
  adminTest: `${ADMIN}/test`
} as const
