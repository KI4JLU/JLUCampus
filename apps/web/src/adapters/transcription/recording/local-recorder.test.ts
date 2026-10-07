import { afterEach, describe, expect, it, vi } from 'vitest'
import { startLocalRecorder } from './local-recorder'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** The recorders made, newest last. */
const made: FakeRecorder[] = []

/** A MediaRecorder that, as the browser's, delivers its last chunk and `stop` after `stop()`. */
class FakeRecorder extends EventTarget {
  state: RecordingState = 'inactive'
  constructor() {
    super()
    made.push(this)
  }
  mimeType = 'audio/webm'
  start(): void {
    this.state = 'recording'
  }
  stop(): void {
    this.state = 'inactive'
    setTimeout(() => {
      this.chunk('last')
      this.dispatchEvent(new Event('stop'))
    }, 1)
  }
  chunk(text: string): void {
    const event = new Event('dataavailable') as Event & { data: Blob }
    event.data = new Blob([text])
    this.dispatchEvent(event)
  }
}

describe('startLocalRecorder', () => {
  it('hands the chunk after a discard on and resolves only after it', async () => {
    vi.stubGlobal('MediaRecorder', FakeRecorder)
    const chunks: Blob[] = []
    const local = startLocalRecorder({} as MediaStream, { onChunk: (chunk) => chunks.push(chunk) })
    const recorder = made.at(-1)!
    recorder.chunk('first')
    await local.discard()
    expect(await Promise.all(chunks.map((chunk) => chunk.text()))).toEqual(['first', 'last'])
  })

  it('waits for the last chunk when the recorder already stopped with its stream', async () => {
    vi.stubGlobal('MediaRecorder', FakeRecorder)
    const local = startLocalRecorder({} as MediaStream)
    const recorder = made.at(-1)!
    recorder.chunk('first')
    // The stream ended: the recorder is inactive at once, its last chunk follows.
    recorder.stop()
    const blob = await local.stop()
    expect(await blob.text()).toBe('firstlast')
  })
})
