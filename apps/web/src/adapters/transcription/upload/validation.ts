import {
  checkTranscriptionFile,
  TRANSCRIPTION_MAX_FILE_BYTES,
  type TranscriptionFileCheck
} from '@justcampus/shared'

/** A file the queue refused, and why. */
export interface RejectedFile {
  file: File
  reason: Exclude<TranscriptionFileCheck, 'ok'>
}

/**
 * kiChat's check after selection (T-04): a supported MIME type or extension and at most
 * `maxBytes`, the limit itself included. The file input accepts anything; this decides.
 */
export function partitionFiles(
  files: readonly File[],
  maxBytes: number = TRANSCRIPTION_MAX_FILE_BYTES
): { accepted: File[]; rejected: RejectedFile[] } {
  const accepted: File[] = []
  const rejected: RejectedFile[] = []
  for (const file of files) {
    const check = checkTranscriptionFile(file, maxBytes)
    if (check === 'ok') accepted.push(file)
    else rejected.push({ file, reason: check })
  }
  return { accepted, rejected }
}

/** The limit in whole megabytes, as the hint names it (`500`). */
export function limitMegabytes(maxBytes: number): number {
  return Math.round(maxBytes / (1024 * 1024))
}
