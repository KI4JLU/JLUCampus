import { describe, expect, it } from 'vitest'
import { createResampler, lowPassTaps, mixDown, PcmFramer, toBase64, toPcm16 } from './pcm'

function sine(frequency: number, rate: number, seconds: number): Float32Array {
  const samples = new Float32Array(Math.round(rate * seconds))
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = 0.5 * Math.sin((2 * Math.PI * frequency * index) / rate)
  }
  return samples
}

/** The root mean square of the samples, without the filter's settling at the start. */
function rms(samples: Float32Array, skip = 200): number {
  let sum = 0
  for (let index = skip; index < samples.length; index += 1) sum += samples[index]! ** 2
  return Math.sqrt(sum / (samples.length - skip))
}

/** The strength of `frequency` in the samples (one bin of a DFT). */
function strength(samples: Float32Array, frequency: number, rate: number): number {
  let re = 0
  let im = 0
  for (let index = 0; index < samples.length; index += 1) {
    re += samples[index]! * Math.cos((2 * Math.PI * frequency * index) / rate)
    im -= samples[index]! * Math.sin((2 * Math.PI * frequency * index) / rate)
  }
  return Math.hypot(re, im) / samples.length
}

describe('resampling', () => {
  it('turns a second at 48 kHz into a second at 16 kHz and keeps a speech tone', () => {
    const resampled = createResampler(48_000, 16_000)(sine(440, 48_000, 1))
    expect(resampled.length).toBe(16_000)
    // A sine of amplitude 0.5 has an RMS of 0.354; the low-pass keeps the speech band.
    expect(rms(resampled)).toBeCloseTo(0.354, 2)
    expect(strength(resampled, 440, 16_000)).toBeGreaterThan(0.2)
  })

  it('removes what lies above the new Nyquist frequency instead of folding it back', () => {
    // 12 kHz would alias to 4 kHz at 16 kHz.
    const resampled = createResampler(48_000, 16_000)(sine(12_000, 48_000, 1))
    expect(rms(resampled)).toBeLessThan(0.01)
    expect(strength(resampled, 4000, 16_000)).toBeLessThan(0.005)
  })

  it('handles rates that do not divide, and upsampling', () => {
    expect(createResampler(44_100, 16_000)(sine(440, 44_100, 1)).length).toBeCloseTo(16_000, -1)
    expect(createResampler(48_000, 24_000)(sine(440, 48_000, 1)).length).toBe(24_000)
    const up = createResampler(16_000, 24_000)(sine(440, 16_000, 1))
    expect(up.length).toBeCloseTo(24_000, -1)
    expect(rms(up)).toBeCloseTo(0.354, 2)
    const same = sine(440, 16_000, 0.01)
    expect(createResampler(16_000, 16_000)(same)).toEqual(same)
  })

  it('gives the same output for a stream in chunks as for it whole', () => {
    const input = sine(300, 44_100, 0.5)
    const whole = createResampler(44_100, 16_000)(input)
    const chunked = createResampler(44_100, 16_000)
    const parts: number[] = []
    // AudioWorklet quanta of 128, and odd lengths.
    for (
      let start = 0, size = 128;
      start < input.length;
      start += size, size = size === 128 ? 77 : 128
    ) {
      parts.push(...chunked(input.subarray(start, start + size)))
    }
    expect(parts.length).toBe(whole.length)
    for (let index = 0; index < whole.length; index += 1) {
      expect(parts[index]).toBeCloseTo(whole[index]!, 5)
    }
  })

  it('has a low-pass that passes silence through as silence and keeps the level', () => {
    const taps = lowPassTaps(3)
    expect(taps.reduce((sum, tap) => sum + tap, 0)).toBeCloseTo(1, 6)
    expect(taps.length % 2).toBe(1)
  })
})

describe('PCM16 frames', () => {
  it('encodes little-endian 16-bit samples, clipped', () => {
    expect([...toPcm16(Float32Array.from([0, 1, -1, 2, -2, 0.5]))]).toEqual([
      0, 0, 0xff, 0x7f, 0x00, 0x80, 0xff, 0x7f, 0x00, 0x80, 0x00, 0x40
    ])
  })

  it('mixes channels to mono', () => {
    expect([...mixDown([Float32Array.from([1, 0]), Float32Array.from([0, 1])])]).toEqual([0.5, 0.5])
  })

  it('cuts 100 ms frames at the target rate, and flushes the rest', () => {
    const framer = new PcmFramer(48_000, 16_000, 100)
    const frames: Uint8Array[] = []
    // A quarter second in render quanta of 128 samples.
    const input = sine(440, 48_000, 0.25)
    for (let start = 0; start < input.length; start += 128) {
      frames.push(...framer.push(input.subarray(start, start + 128)))
    }
    expect(frames).toHaveLength(2)
    for (const frame of frames) expect(frame.length).toBe(3200)
    const rest = framer.flush()
    expect(rest?.length).toBeCloseTo(1600, -2)
    expect(framer.flush()).toBeNull()
  })

  it('writes base64, also for frames longer than one call of fromCharCode takes', () => {
    expect(toBase64(Uint8Array.from([0, 1, 2, 3]))).toBe('AAECAw==')
    const long = new Uint8Array(100_000).fill(7)
    expect(Buffer.from(toBase64(long), 'base64')).toEqual(Buffer.from(long))
  })
})
