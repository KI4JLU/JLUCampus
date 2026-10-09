import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ACTIVITY_HOLD_MS,
  ACTIVITY_THRESHOLD,
  gateActivity,
  QUIET,
  rootMeanSquare,
  watchActivity,
  type ActivityGate
} from './level-meter'

describe('rootMeanSquare', () => {
  it('measures the level of the samples', () => {
    expect(rootMeanSquare([])).toBe(0)
    expect(rootMeanSquare([0, 0, 0])).toBe(0)
    expect(rootMeanSquare([0.5, -0.5, 0.5, -0.5])).toBeCloseTo(0.5)
    expect(rootMeanSquare(new Float32Array([1, 0, 0, 0]))).toBeCloseTo(0.5)
  })
})

describe('gateActivity', () => {
  const loud = ACTIVITY_THRESHOLD * 2
  const quiet = ACTIVITY_THRESHOLD / 4

  it('turns active with the first loud reading', () => {
    expect(gateActivity(QUIET, loud, 1000)).toEqual({ active: true, loudAt: 1000 })
  })

  it('stays quiet without a loud reading, changing nothing', () => {
    expect(gateActivity(QUIET, quiet, 1000)).toBe(QUIET)
  })

  it('holds a short while after the last loud reading, so pauses do not flicker', () => {
    const lit = gateActivity(QUIET, loud, 1000)
    const pause = gateActivity(lit, quiet, 1000 + ACTIVITY_HOLD_MS - 1)
    expect(pause).toBe(lit)
    const again = gateActivity(pause, loud, 1000 + ACTIVITY_HOLD_MS - 1)
    expect(again).toEqual({ active: true, loudAt: 1000 + ACTIVITY_HOLD_MS - 1 })
  })

  it('turns quiet once the hold is over', () => {
    const lit = gateActivity(QUIET, loud, 1000)
    const out = gateActivity(lit, quiet, 1000 + ACTIVITY_HOLD_MS)
    expect(out).toEqual({ active: false, loudAt: 1000 })
    expect(gateActivity(out, quiet, 5000)).toBe(out)
  })

  it('takes a threshold and hold of its own', () => {
    const gate: ActivityGate = gateActivity(QUIET, 0.2, 0, 0.1, 50)
    expect(gate.active).toBe(true)
    expect(gateActivity(gate, 0.05, 49, 0.1, 50).active).toBe(true)
    expect(gateActivity(gate, 0.05, 50, 0.1, 50).active).toBe(false)
  })
})

/** A fake `AudioContext` whose analysers read `level` as a square wave. */
function fakeAudio(): {
  contexts: { close: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn> }[]
  level: { value: number }
  listeners: Set<string>
} {
  const contexts: { close: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn> }[] = []
  const level = { value: 0 }
  const listeners = new Set<string>()
  class FakeAudioContext {
    state = 'running'
    close = vi.fn(() => Promise.resolve())
    resume = vi.fn(() => Promise.resolve())
    constructor() {
      contexts.push(this)
    }
    createMediaStreamSource(): unknown {
      return { connect: vi.fn(), disconnect: vi.fn() }
    }
    createAnalyser(): unknown {
      return {
        fftSize: 0,
        getFloatTimeDomainData: (samples: Float32Array) =>
          samples.forEach((_, index) => (samples[index] = index % 2 ? level.value : -level.value))
      }
    }
  }
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('document', {
    addEventListener: (type: string) => listeners.add(type),
    removeEventListener: (type: string) => listeners.delete(type)
  })
  return { contexts, level, listeners }
}

const stream = (tracks = 1): MediaStream =>
  ({ getAudioTracks: () => Array.from({ length: tracks }, () => ({})) }) as unknown as MediaStream

describe('watchActivity', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('tells each flip once, and closes the shared context with the last meter', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] })
    const { contexts, level, listeners } = fakeAudio()
    const first = vi.fn()
    const second = vi.fn()
    const unwatchFirst = watchActivity(stream(), first)
    const unwatchSecond = watchActivity(stream(), second)
    expect(contexts).toHaveLength(1)
    expect(listeners).toEqual(new Set(['pointerdown', 'keydown']))

    vi.advanceTimersByTime(500)
    expect(first).not.toHaveBeenCalled()
    level.value = 0.5
    vi.advanceTimersByTime(500)
    expect(first.mock.calls).toEqual([[true]])
    expect(second.mock.calls).toEqual([[true]])
    level.value = 0
    vi.advanceTimersByTime(ACTIVITY_HOLD_MS + 200)
    expect(first.mock.calls).toEqual([[true], [false]])

    unwatchFirst()
    expect(contexts[0]!.close).not.toHaveBeenCalled()
    unwatchSecond()
    unwatchSecond()
    expect(contexts[0]!.close).toHaveBeenCalledOnce()
    expect(listeners.size).toBe(0)
    // Released meters are not read any more.
    level.value = 0.5
    vi.advanceTimersByTime(500)
    expect(second.mock.calls).toEqual([[true], [false]])
  })

  it('meters nothing for a stream without audio', () => {
    const { contexts } = fakeAudio()
    const onChange = vi.fn()
    watchActivity(stream(0), onChange)()
    expect(contexts).toHaveLength(0)
  })
})
