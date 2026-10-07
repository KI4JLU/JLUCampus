/** A MediaRecorder on a microphone or mixed stream, collecting its chunks in memory. */
export interface LocalRecorder {
  /**
   * What the recorder writes, once it says so: its type after its `start` event (Safari names its
   * default MP4 only then), else its first chunk's type; `''` if it ended without naming one.
   */
  mimeType: Promise<string>
  /** Waits for the last chunk and returns the recording in the browser's own format. */
  stop: () => Promise<Blob>
  /**
   * Drops what was recorded, e.g. when the page goes away. Resolves once the recorder ended: its
   * last chunk still goes to `onChunk`, so the take's backup gets it.
   */
  discard: () => Promise<void>
}

/** Chunks every second, so a recording that ends unexpectedly still has its audio. */
const TIMESLICE_MS = 1000

export interface LocalRecorderOptions {
  /** The browser's own format when left out. */
  mimeType?: string
  audioBitsPerSecond?: number
  /** Every chunk as it arrives, e.g. to back the take up in the browser's storage. */
  onChunk?: (chunk: Blob) => void
}

/**
 * Records `stream` locally (T-56, T-57). Regular recording records its mix; live transcription
 * records the stream it sends, so a stopped session also yields a take.
 */
export function startLocalRecorder(
  stream: MediaStream,
  { mimeType, audioBitsPerSecond, onChunk }: LocalRecorderOptions = {}
): LocalRecorder {
  const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond })
  const chunks: Blob[] = []
  let discarded = false
  let named: (type: string) => void = () => undefined
  const type = new Promise<string>((resolve) => {
    named = resolve
  })
  // An asked-for type is what the recorder writes: it refuses one it cannot.
  recorder.addEventListener('start', () => {
    const known = recorder.mimeType || mimeType
    if (known) named(known)
  })
  recorder.addEventListener('dataavailable', (event) => {
    if (event.data.size === 0) return
    const known = recorder.mimeType || event.data.type
    if (known) named(known)
    if (!discarded) chunks.push(event.data)
    onChunk?.(event.data)
  })
  // `stop` fires after the final `dataavailable`, also when the recorder ended with its stream;
  // its state is `inactive` before.
  const ended = new Promise<void>((resolve) => {
    recorder.addEventListener(
      'stop',
      () => {
        named(recorder.mimeType)
        resolve()
      },
      { once: true }
    )
  })
  recorder.start(TIMESLICE_MS)

  const end = (): Promise<void> => {
    if (recorder.state !== 'inactive') {
      try {
        recorder.stop()
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
    return ended
  }
  let stopping: Promise<Blob> | null = null

  return {
    mimeType: type,
    stop: () => {
      stopping ??= end()
        .then(() => type)
        .then((written) => new Blob(chunks, { type: written }))
      return stopping
    },
    discard: () => {
      discarded = true
      chunks.length = 0
      // Already ended with its stream, if stopping fails.
      return end().catch(() => undefined)
    }
  }
}

/** Ends every track of the stream, which releases the microphone. */
export function releaseStream(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) track.stop()
}
