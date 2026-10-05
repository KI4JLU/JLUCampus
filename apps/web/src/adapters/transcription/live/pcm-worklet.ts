/**
 * The AudioWorklet of live transcription (T-60): takes the microphone at the audio context's
 * rate, mixes it to mono and posts PCM16 frames at the mode's rate to the page (`pcm.ts`).
 * Vite builds it as a file of its own (`?worker&url` in `audio.ts`), so it loads from the app's
 * origin under a `script-src 'self'` policy, in the browser, the PWA and the desktop app alike.
 *
 * The page posts `'flush'` when it stops; the worklet answers with what is left of the last frame
 * (if anything) and `'flushed'`.
 */
import { mixDown, PcmFramer } from './pcm'

// The AudioWorklet global scope, which TypeScript's DOM library does not describe.
declare const sampleRate: number
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}
declare function registerProcessor(
  name: string,
  processor: new (options: AudioWorkletNodeOptions) => AudioWorkletProcessor
): void

interface CaptureOptions {
  targetRate: number
  frameMs: number
}

class PcmCaptureProcessor extends AudioWorkletProcessor {
  private readonly framer: PcmFramer

  constructor(options: AudioWorkletNodeOptions) {
    super()
    const { targetRate, frameMs } = options.processorOptions as CaptureOptions
    this.framer = new PcmFramer(sampleRate, targetRate, frameMs)
    this.port.onmessage = (event: MessageEvent) => {
      if (event.data !== 'flush') return
      const rest = this.framer.flush()
      if (rest) this.port.postMessage(rest, [rest.buffer])
      this.port.postMessage('flushed')
    }
  }

  process(inputs: Float32Array[][]): boolean {
    const channels = inputs[0]
    if (channels && channels.length > 0) {
      for (const frame of this.framer.push(mixDown(channels))) {
        this.port.postMessage(frame, [frame.buffer])
      }
    }
    return true
  }
}

registerProcessor('jlu-pcm-capture', PcmCaptureProcessor)
