import { TRANSCRIPTION_LIVE_FRAME_MS } from '@justcampus/shared'
import workletUrl from './pcm-worklet.ts?worker&url'

/**
 * The browser's side of the live audio (T-60): the microphone stream (with the echo
 * cancellation and noise suppression of its track) into an AudioWorklet that resamples it to the
 * mode's rate and posts PCM16 frames (`pcm-worklet.ts`). The local recording takes the same
 * stream through its own MediaRecorder.
 */

/** A running capture. */
export interface AudioCapture {
  /** Sends what is left of the last frame, then stops. */
  stop: () => Promise<void>
  /** Stops at once. */
  close: () => void
}

/** How long stopping waits for the worklet's last frame. */
const FLUSH_TIMEOUT_MS = 500

export async function startPcmCapture(
  stream: MediaStream,
  sampleRate: number,
  onFrame: (pcm: Uint8Array) => void
): Promise<AudioCapture> {
  // The context's own rate: Firefox cannot connect a microphone to a context of another rate.
  const context = new AudioContext()
  let flushed: (() => void) | null = null
  try {
    await context.audioWorklet.addModule(workletUrl)
    const source = context.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(context, 'jlu-pcm-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
      processorOptions: { targetRate: sampleRate, frameMs: TRANSCRIPTION_LIVE_FRAME_MS }
    })
    node.port.onmessage = (event: MessageEvent<unknown>) => {
      if (event.data === 'flushed') flushed?.()
      else if (event.data instanceof Uint8Array) onFrame(event.data)
    }
    // Silent, but connected: a node the destination does not pull from is not processed.
    const mute = context.createGain()
    mute.gain.value = 0
    source.connect(node).connect(mute).connect(context.destination)
    if (context.state === 'suspended') await context.resume()

    let closed = false
    const close = (): void => {
      if (closed) return
      closed = true
      node.port.onmessage = null
      source.disconnect()
      node.disconnect()
      void context.close().catch(() => {})
    }
    return {
      close,
      stop: async () => {
        if (closed) return
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, FLUSH_TIMEOUT_MS)
          flushed = () => {
            clearTimeout(timer)
            resolve()
          }
          node.port.postMessage('flush')
        })
        close()
      }
    }
  } catch (error) {
    void context.close().catch(() => {})
    throw error
  }
}
