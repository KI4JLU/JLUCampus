/**
 * The microphone's audio as the live WebSocket carries it (T-60): mono, resampled from the audio
 * context's rate to the mode's (`TRANSCRIPTION_REALTIME_SAMPLE_RATES`), 16-bit little-endian PCM
 * in frames of `TRANSCRIPTION_LIVE_FRAME_MS`, base64 in `input_audio_buffer.append`. Pure, so the
 * AudioWorklet (`pcm-worklet.ts`) and the tests share it; kiChat's bridge did the same with
 * PyAV's resampler on the server.
 */

/**
 * A windowed-sinc low-pass for downsampling by `ratio` (input rate / output rate): it keeps the
 * band below 90 % of the output's Nyquist frequency and removes what would fold back into it.
 */
export function lowPassTaps(ratio: number): Float32Array {
  const cutoff = 0.45 / ratio
  const half = Math.ceil(4 * ratio)
  const taps = new Float32Array(2 * half + 1)
  let sum = 0
  for (let index = 0; index < taps.length; index += 1) {
    const offset = index - half
    const sinc =
      offset === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * offset) / (Math.PI * offset)
    // Blackman window.
    const phase = (2 * Math.PI * index) / (taps.length - 1)
    const window = 0.42 - 0.5 * Math.cos(phase) + 0.08 * Math.cos(2 * phase)
    taps[index] = sinc * window
    sum += taps[index]!
  }
  for (let index = 0; index < taps.length; index += 1) taps[index] = taps[index]! / sum
  return taps
}

/**
 * A streaming resampler from `inputRate` to `outputRate`: low-pass first when it downsamples,
 * then linear interpolation. Chunks may have any length; the output of several chunks equals that
 * of their concatenation.
 */
export function createResampler(
  inputRate: number,
  outputRate: number
): (input: Float32Array) => Float32Array {
  if (inputRate === outputRate) return (input) => input.slice()
  const ratio = inputRate / outputRate
  const taps = ratio > 1 ? lowPassTaps(ratio) : null
  let history = new Float32Array(taps ? taps.length - 1 : 0)
  /** The last filtered sample of the chunk before, at position -1. */
  let previous = 0
  /** Where the next output sample lies in the current chunk's filtered samples. */
  let position = 0
  return (input) => {
    let filtered = input
    if (taps) {
      const extended = new Float32Array(history.length + input.length)
      extended.set(history)
      extended.set(input, history.length)
      filtered = new Float32Array(input.length)
      for (let index = 0; index < input.length; index += 1) {
        let sum = 0
        for (let tap = 0; tap < taps.length; tap += 1) sum += taps[tap]! * extended[index + tap]!
        filtered[index] = sum
      }
      history = extended.slice(extended.length - history.length)
    }
    const output: number[] = []
    const at = (index: number): number => (index < 0 ? previous : filtered[index]!)
    for (;;) {
      const index = Math.floor(position)
      if (index + 1 >= filtered.length) break
      const fraction = position - index
      output.push(at(index) * (1 - fraction) + at(index + 1) * fraction)
      position += ratio
    }
    if (filtered.length > 0) {
      position -= filtered.length
      previous = filtered[filtered.length - 1]!
    }
    return Float32Array.from(output)
  }
}

/** Samples in [-1, 1] as 16-bit little-endian PCM, clipped. */
export function toPcm16(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2)
  const view = new DataView(bytes.buffer)
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]!))
    view.setInt16(index * 2, Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff), true)
  }
  return bytes
}

/** The average of the channels, for a mono stream. */
export function mixDown(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0]!
  const length = channels[0]?.length ?? 0
  const mono = new Float32Array(length)
  for (const channel of channels) {
    for (let index = 0; index < length; index += 1)
      mono[index]! += channel[index]! / channels.length
  }
  return mono
}

/**
 * Resamples a mono stream and cuts it into PCM16 frames of `frameMs`; `flush` hands out the rest
 * when the stream ends.
 */
export class PcmFramer {
  private readonly resample: (input: Float32Array) => Float32Array
  private readonly frameSamples: number
  private pending = new Float32Array(0)

  constructor(inputRate: number, outputRate: number, frameMs: number) {
    this.resample = createResampler(inputRate, outputRate)
    this.frameSamples = Math.round((outputRate * frameMs) / 1000)
  }

  /** The complete frames this input finishes. */
  push(input: Float32Array): Uint8Array[] {
    const resampled = this.resample(input)
    const joined = new Float32Array(this.pending.length + resampled.length)
    joined.set(this.pending)
    joined.set(resampled, this.pending.length)
    const frames: Uint8Array[] = []
    let start = 0
    while (joined.length - start >= this.frameSamples) {
      frames.push(toPcm16(joined.subarray(start, start + this.frameSamples)))
      start += this.frameSamples
    }
    this.pending = joined.slice(start)
    return frames
  }

  /** What is left of the last frame, or `null` without anything. */
  flush(): Uint8Array | null {
    if (this.pending.length === 0) return null
    const rest = toPcm16(this.pending)
    this.pending = new Float32Array(0)
    return rest
  }
}

/** Bytes as base64, in slices that `String.fromCharCode` takes. */
export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000))
  }
  return btoa(binary)
}
