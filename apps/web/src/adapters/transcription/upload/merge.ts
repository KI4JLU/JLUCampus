import {
  defaultSpeakerColorId,
  TRANSCRIPTION_TITLE_MAX,
  type TranscriptionResult,
  type TranscriptionSegment,
  type TranscriptionSourceFile,
  type TranscriptionSpeakerColorId,
  type TranscriptionSpeakerColorMap,
  type TranscriptionTranscriptCreate,
  type TranscriptionWord
} from '@justcampus/shared'

/**
 * Joins the results of a group's files into one transcript, as kiChat's `startTranscription` does
 * (T-14): in file order, later files' times shifted by what came before.
 */

/** One file of a group with its finished result. */
export interface FileResult {
  name: string
  size: number
  jobId: string | null
  result: TranscriptionResult
}

/**
 * How long a result counts in the joined timeline: its duration, else the end of its last segment,
 * else 0. Trailing silence the engine left out is then missing from the offsets, as in kiChat.
 */
export function resultDuration(result: TranscriptionResult): number {
  if (result.duration) return result.duration
  const last = result.segments[result.segments.length - 1]
  return last?.end ?? 0
}

export interface MergedResult {
  text: string
  language: string | null
  /** The summed durations, rounded to whole seconds as kiChat saves them. */
  duration: number
  segments: TranscriptionSegment[]
  words: TranscriptionWord[]
  sourceFiles: TranscriptionSourceFile[]
}

const shiftWord = (word: TranscriptionWord, offset: number): TranscriptionWord => ({
  ...word,
  start: word.start + offset,
  end: word.end + offset
})

/**
 * The joined result. Segments keep their ids, those of later files raised above all ids before, so
 * they stay unique; a single file keeps its ids as they are. Texts join with a space, empty ones
 * left out. The language is the first file's.
 */
export function mergeResults(files: readonly FileResult[]): MergedResult {
  const segments: TranscriptionSegment[] = []
  const words: TranscriptionWord[] = []
  const sourceFiles: TranscriptionSourceFile[] = []
  const texts: string[] = []
  let offset = 0
  let nextId = 0
  for (const { name, size, jobId, result } of files) {
    const duration = resultDuration(result)
    sourceFiles.push({
      jobId,
      name,
      size,
      duration,
      startTime: offset,
      endTime: offset + duration
    })
    const idBase = nextId
    for (const segment of result.segments) {
      const id = segment.id + idBase
      segments.push({
        ...segment,
        id,
        start: segment.start + offset,
        end: segment.end + offset,
        ...(segment.words ? { words: segment.words.map((word) => shiftWord(word, offset)) } : {})
      })
      nextId = Math.max(nextId, id + 1)
    }
    words.push(...result.words.map((word) => shiftWord(word, offset)))
    if (result.text.trim()) texts.push(result.text)
    offset += duration
  }
  return {
    text: texts.join(' '),
    language: files[0]?.result.language ?? null,
    duration: Math.round(offset),
    segments,
    words,
    sourceFiles
  }
}

/**
 * The colours saved with the transcript, by speaker name in order of first appearance: the colour
 * the mapping dialog showed for that name, else that of the speaker's place.
 */
export function speakerColorsFor(
  segments: readonly TranscriptionSegment[],
  chosen: ReadonlyMap<string, TranscriptionSpeakerColorId>
): TranscriptionSpeakerColorMap {
  const colors: TranscriptionSpeakerColorMap = {}
  let index = 0
  for (const segment of segments) {
    const name = segment.speaker
    if (name === null || name in colors) continue
    colors[name] = {
      colorId: chosen.get(name) ?? defaultSpeakerColorId(index),
      speakerIndex: index
    }
    index++
  }
  return colors
}

/** The save request of a group (`POST TRANSCRIPTION_API.transcripts`). */
export function transcriptCreate(input: {
  idempotencyKey: string
  title: string
  files: readonly FileResult[]
  chosenColors: ReadonlyMap<string, TranscriptionSpeakerColorId>
}): TranscriptionTranscriptCreate {
  const merged = mergeResults(input.files)
  return {
    idempotencyKey: input.idempotencyKey,
    title: input.title.trim().slice(0, TRANSCRIPTION_TITLE_MAX),
    jobIds: input.files.flatMap((file) => (file.jobId ? [file.jobId] : [])),
    language: merged.language,
    duration: merged.duration,
    segments: merged.segments,
    words: merged.words,
    sourceFiles: merged.sourceFiles,
    speakerColors: speakerColorsFor(merged.segments, input.chosenColors)
  }
}
