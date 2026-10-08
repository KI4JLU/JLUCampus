/**
 * Whether a source picks up sound, for the icons that light up beside it: the level of each
 * metered stream is read a few times a second through one shared `AudioContext`, and a source
 * counts as active while it is loud, and a short hold after, so the icon does not flicker between
 * syllables. The context closes with the last meter.
 */

/** RMS of the samples, about -36 dBFS: speech near the microphone, not a quiet room. */
export const ACTIVITY_THRESHOLD = 0.016
/** How long a source stays active after it was last loud. */
export const ACTIVITY_HOLD_MS = 300
/** How often the levels are read. */
const SAMPLE_INTERVAL_MS = 80

export interface ActivityGate {
  active: boolean
  /** When the source was last loud, in milliseconds; `-Infinity` before. */
  loudAt: number
}

export const QUIET: ActivityGate = { active: false, loudAt: Number.NEGATIVE_INFINITY }

/** The root mean square of time-domain samples between -1 and 1. */
export function rootMeanSquare(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let index = 0; index < samples.length; index++) sum += samples[index]! * samples[index]!
  return Math.sqrt(sum / samples.length)
}

/**
 * The gate after a reading of `level` at `now`: active from the first loud reading until `hold`
 * after the last one. Returns `gate` itself when nothing changed.
 */
export function gateActivity(
  gate: ActivityGate,
  level: number,
  now: number,
  threshold = ACTIVITY_THRESHOLD,
  hold = ACTIVITY_HOLD_MS
): ActivityGate {
  if (level >= threshold) return { active: true, loudAt: now }
  const active = now - gate.loudAt < hold
  return active === gate.active ? gate : { ...gate, active }
}

interface Meter {
  analyser: AnalyserNode
  source: MediaStreamAudioSourceNode
  samples: Float32Array<ArrayBuffer>
  gate: ActivityGate
  onChange: (active: boolean) => void
}

interface Shared {
  context: AudioContext
  meters: Set<Meter>
  timer: ReturnType<typeof setInterval>
  /** Resumes the context on the page's next click or key. */
  wake: () => void
}

const WAKE_EVENTS = ['pointerdown', 'keydown'] as const

let shared: Shared | null = null

function read(meters: ReadonlySet<Meter>): void {
  const now = performance.now()
  for (const meter of meters) {
    meter.analyser.getFloatTimeDomainData(meter.samples)
    const gate = gateActivity(meter.gate, rootMeanSquare(meter.samples), now)
    if (gate.active !== meter.gate.active) meter.onChange(gate.active)
    meter.gate = gate
  }
}

/**
 * Meters the audio of `stream` and calls `onChange` each time it turns active or quiet. Returns
 * the release; the stream itself stays open. Without Web Audio, or a stream without audio,
 * nothing is metered.
 */
export function watchActivity(
  stream: MediaStream,
  onChange: (active: boolean) => void
): () => void {
  if (stream.getAudioTracks().length === 0) return () => {}
  if (!shared) {
    let context: AudioContext
    try {
      context = new AudioContext()
    } catch {
      return () => {}
    }
    const meters = new Set<Meter>()
    // Created before any click on the page, the context waits for one.
    const wake = (): void => void context.resume().catch(() => {})
    for (const type of WAKE_EVENTS) document.addEventListener(type, wake, true)
    shared = { context, meters, wake, timer: setInterval(() => read(meters), SAMPLE_INTERVAL_MS) }
  }
  const { context, meters } = shared
  let meter: Meter
  try {
    const source = context.createMediaStreamSource(stream)
    // Not connected on to the speakers: the analyser is read, never heard.
    const analyser = context.createAnalyser()
    analyser.fftSize = 2048
    source.connect(analyser)
    meter = {
      analyser,
      source,
      samples: new Float32Array(analyser.fftSize),
      gate: QUIET,
      onChange
    }
  } catch {
    if (meters.size === 0) closeShared()
    return () => {}
  }
  meters.add(meter)
  if (context.state === 'suspended') shared.wake()
  return () => {
    if (!meters.delete(meter)) return
    meter.source.disconnect()
    if (meters.size === 0) closeShared()
  }
}

function closeShared(): void {
  if (!shared) return
  clearInterval(shared.timer)
  for (const type of WAKE_EVENTS) document.removeEventListener(type, shared.wake, true)
  void shared.context.close().catch(() => {})
  shared = null
}
