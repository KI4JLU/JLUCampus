import { describe, expect, it, vi, type Mock } from 'vitest'
import { AudioMixer, type MixerContext } from './mixer'

/** A source node of the fake context: which stream it plays and where it is connected. */
interface FakeSource {
  stream: MediaStream
  connected: unknown[]
  connect: (target: unknown) => void
  disconnect: () => void
}

interface FakeContext {
  context: MixerContext & { resume: Mock; close: Mock }
  destination: Record<string, unknown> & { disconnect: Mock }
  sources: FakeSource[]
  mixed: MediaStream
}

function fakeContext(state: AudioContextState = 'running'): FakeContext {
  const mixed = { id: 'mix' } as unknown as MediaStream
  const destination = {
    stream: mixed,
    channelCount: 2,
    channelCountMode: 'max',
    channelInterpretation: 'discrete',
    disconnect: vi.fn()
  }
  const sources: FakeSource[] = []
  const context = {
    state,
    resume: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    createMediaStreamDestination: () => destination,
    createMediaStreamSource: (stream: MediaStream) => {
      const source: FakeSource = {
        stream,
        connected: [],
        connect: (target) => source.connected.push(target),
        disconnect: () => {
          source.connected = []
        }
      }
      sources.push(source)
      return source
    }
  }
  return { context: context as unknown as FakeContext['context'], destination, sources, mixed }
}

const stream = (id: string): MediaStream => ({ id }) as unknown as MediaStream

describe('AudioMixer', () => {
  it('mixes down to one explicit mono track with the speakers downmix', () => {
    const { context, destination, mixed } = fakeContext()
    const mixer = new AudioMixer(context)
    expect(mixer.stream).toBe(mixed)
    expect(destination).toMatchObject({
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers'
    })
  })

  it('connects and disconnects sources while the mix stays', () => {
    const { context, destination, sources } = fakeContext()
    const mixer = new AudioMixer(context)
    mixer.add('main', stream('mic'))
    mixer.add('tab', stream('tab'))
    expect(mixer.size).toBe(2)
    expect(sources.map((source) => source.connected)).toEqual([[destination], [destination]])

    expect(mixer.remove('tab')).toBe(true)
    expect(mixer.remove('tab')).toBe(false)
    expect(sources[1]!.connected).toEqual([])
    expect(mixer.has('main')).toBe(true)
    expect(mixer.size).toBe(1)
  })

  it('swaps a source in place under the same id', () => {
    const { context, destination, sources } = fakeContext()
    const mixer = new AudioMixer(context)
    mixer.add('main', stream('old'))
    mixer.add('main', stream('new'))
    expect(mixer.size).toBe(1)
    expect(sources[0]!.connected).toEqual([])
    expect(sources[1]).toMatchObject({ connected: [destination], stream: { id: 'new' } })
  })

  it('catches up with the sources that changed while a take started', () => {
    const { context, destination, sources } = fakeContext()
    const mixer = new AudioMixer(context)
    const microphone = stream('b')
    mixer.add('main', stream('a'))
    mixer.add('b', microphone)
    mixer.add('tab', stream('tab'))
    // The main microphone went; the added one took its place with its open stream.
    mixer.sync(
      new Map([
        ['main', microphone],
        ['tab', sources[2]!.stream]
      ])
    )
    expect(mixer.size).toBe(2)
    expect(mixer.has('b')).toBe(false)
    expect(sources[0]!.connected).toEqual([])
    expect(sources[1]!.connected).toEqual([])
    // The tab plays on untouched; the handed-over stream connects under the main id.
    expect(sources[2]!.connected).toEqual([destination])
    expect(sources[3]).toMatchObject({ connected: [destination], stream: { id: 'b' } })
    expect(sources).toHaveLength(4)
  })

  it('resumes a suspended context and closes everything once', async () => {
    const { context, destination, sources } = fakeContext('suspended')
    const mixer = new AudioMixer(context)
    await mixer.run()
    expect(context.resume).toHaveBeenCalledOnce()
    mixer.add('main', stream('mic'))
    mixer.close()
    mixer.close()
    expect(sources[0]!.connected).toEqual([])
    expect(destination.disconnect).toHaveBeenCalledOnce()
    expect(context.close).toHaveBeenCalledOnce()
    // Closed: nothing connects any more.
    mixer.add('late', stream('late'))
    expect(mixer.size).toBe(0)
  })
})
