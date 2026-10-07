/** A MediaRecorder on a microphone (or meeting) stream, collecting its chunks in memory. */
export interface LocalRecorder {
  /** Waits for the last chunk and returns the recording in the browser's own format. */
  stop: () => Promise<Blob>
  /** Drops what was recorded, e.g. when the page goes away. */
  discard: () => void
}

/** Chunks every second, so a recording that ends unexpectedly still has its audio. */
const TIMESLICE_MS = 1000

export interface LocalRecorderOptions {
  /** The browser's own format when left out. */
  mimeType?: string
  audioBitsPerSecond?: number
  /** Every chunk as it arrives, e.g. to back a meeting up in the browser's storage. */
  onChunk?: (chunk: Blob) => void
}

/**
 * Records `stream` locally (T-56, T-57). Regular recording, live transcription and meetings share
 * it: live transcription records the stream it sends, so a stopped session also yields a take.
 */
export function startLocalRecorder(
  stream: MediaStream,
  { mimeType, audioBitsPerSecond, onChunk }: LocalRecorderOptions = {}
): LocalRecorder {
  const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond })
  const chunks: Blob[] = []
  recorder.addEventListener('dataavailable', (event) => {
    if (event.data.size === 0) return
    chunks.push(event.data)
    onChunk?.(event.data)
  })
  recorder.start(TIMESLICE_MS)

  let stopping: Promise<Blob> | null = null
  const collect = (): Blob => new Blob(chunks, { type: recorder.mimeType || 'audio/webm' })

  return {
    stop: () => {
      stopping ??= new Promise<Blob>((resolve, reject) => {
        if (recorder.state === 'inactive') {
          resolve(collect())
          return
        }
        // `stop` fires after the final `dataavailable`.
        recorder.addEventListener('stop', () => resolve(collect()), { once: true })
        try {
          recorder.stop()
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)))
        }
      })
      return stopping
    },
    discard: () => {
      chunks.length = 0
      if (recorder.state !== 'inactive') {
        try {
          recorder.stop()
        } catch {
          // Already ended with its stream.
        }
      }
    }
  }
}

/** Ends every track of the stream, which releases the microphone. */
export function releaseStream(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) track.stop()
}
