import { afterEach, describe, expect, it, vi } from 'vitest'
import { startLocalRecorder } from './local-recorder'

afterEach(() => {
  vi.unstubAllGlobals()
  FakeRecorder.ownType = 'audio/ogg;codecs=opus'
})

/** The recorders made, newest last. */
const made: FakeRecorder[] = []

/**
 * A MediaRecorder that, as the browser's, names its type with the `start` event after `start()`,
 * and delivers its last chunk and `stop` after `stop()`.
 */
class FakeRecorder extends EventTarget {
  /** The browser's own choice where none was asked for, as Firefox's Ogg; `''` names none. */
  static ownType = 'audio/ogg;codecs=opus'
  state: RecordingState = 'inactive'
  mimeType = ''
  constructor(
    _stream: MediaStream,
    private readonly options: MediaRecorderOptions = {}
  ) {
    super()
    made.push(this)
  }
  start(): void {
    this.state = 'recording'
    setTimeout(() => {
      this.mimeType = this.options.mimeType ?? FakeRecorder.ownType
      this.dispatchEvent(new Event('start'))
    }, 0)
  }
  stop(): void {
    this.state = 'inactive'
    setTimeout(() => {
      this.chunk('last')
      this.dispatchEvent(new Event('stop'))
    }, 1)
  }
  chunk(text: string, type = ''): void {
    const event = new Event('dataavailable') as Event & { data: Blob }
    event.data = new Blob([text], { type })
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

  it('tells the format the recorder writes once it started', async () => {
    vi.stubGlobal('MediaRecorder', FakeRecorder)
    expect(
      await startLocalRecorder({} as MediaStream, { mimeType: 'audio/webm;codecs=opus' }).mimeType
    ).toBe('audio/webm;codecs=opus')
    // Safari names its default MP4 only with the `start` event.
    FakeRecorder.ownType = 'audio/mp4'
    expect(await startLocalRecorder({} as MediaStream).mimeType).toBe('audio/mp4')
  })

  it("takes the first chunk's type when the recorder names none", async () => {
    vi.stubGlobal('MediaRecorder', FakeRecorder)
    FakeRecorder.ownType = ''
    const local = startLocalRecorder({} as MediaStream)
    await new Promise((resolve) => setTimeout(resolve, 5))
    made.at(-1)!.chunk('first', 'audio/mp4')
    expect(await local.mimeType).toBe('audio/mp4')
    expect((await local.stop()).type).toBe('audio/mp4')
  })

  it('names no type when the recorder ended without one', async () => {
    vi.stubGlobal('MediaRecorder', FakeRecorder)
    FakeRecorder.ownType = ''
    const local = startLocalRecorder({} as MediaStream)
    made.at(-1)!.stop()
    expect(await local.mimeType).toBe('')
  })
})
