/** What the mixer uses of an `AudioContext`. */
export type MixerContext = Pick<
  AudioContext,
  'createMediaStreamDestination' | 'createMediaStreamSource' | 'state' | 'resume' | 'close'
>

/**
 * Mixes the sources of a take into one mono track for one MediaRecorder. Sources connect and
 * disconnect while it records; the recorder only ever sees the mix's track, which stays. Explicit
 * mono with the speakers downmix: a stereo tab becomes (L + R) / 2. Nothing goes to
 * `context.destination`: the user would hear shared audio twice.
 */
export class AudioMixer {
  /** The mix, one mono track. */
  readonly stream: MediaStream
  private readonly destination: MediaStreamAudioDestinationNode
  private readonly inputs = new Map<string, MediaStreamAudioSourceNode>()
  private closed = false

  constructor(private readonly context: MixerContext) {
    const destination = context.createMediaStreamDestination()
    destination.channelCount = 1
    destination.channelCountMode = 'explicit'
    destination.channelInterpretation = 'speakers'
    this.destination = destination
    this.stream = destination.stream
  }

  /** Mixes `stream` in as `id`, in place of what had that id. */
  add(id: string, stream: MediaStream): void {
    if (this.closed) return
    this.remove(id)
    const source = this.context.createMediaStreamSource(stream)
    source.connect(this.destination)
    this.inputs.set(id, source)
  }

  /** Takes `id` out of the mix; whether it was in. */
  remove(id: string): boolean {
    const source = this.inputs.get(id)
    if (!source) return false
    source.disconnect()
    this.inputs.delete(id)
    return true
  }

  has(id: string): boolean {
    return this.inputs.has(id)
  }

  /** How many sources are mixed. */
  get size(): number {
    return this.inputs.size
  }

  /** Runs a context the browser created suspended. */
  async run(): Promise<void> {
    if (this.context.state === 'suspended') await this.context.resume()
  }

  /** Disconnects everything and closes the context; the streams are the caller's to release. */
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const source of this.inputs.values()) source.disconnect()
    this.inputs.clear()
    this.destination.disconnect()
    void this.context.close().catch(() => undefined)
  }
}
