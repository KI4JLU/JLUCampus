import { useEffect, useState } from 'react'
import { audioConstraint } from './devices'
import { watchActivity } from './level-meter'
import { releaseStream } from './local-recorder'

/**
 * Whether a source picks up sound now (`level-meter.ts`): from `stream` where one is open for it
 * already, else from a stream of the microphone `deviceId` opened for the meter alone while the
 * caller is mounted and lets go of it as soon as `stream` is there. `null` for both: not metered,
 * e.g. before the microphone permission. Renders again only when the source turns active or quiet,
 * and a source no longer metered turns quiet. `delayMs` waits before opening the microphone, so a
 * `deviceId` that changes again at once opens no stream.
 */
export function useAudioActivity(
  stream: MediaStream | null,
  deviceId: string | null,
  delayMs = 0
): boolean {
  const [active, setActive] = useState(false)

  useEffect(() => {
    if (stream) {
      const unwatch = watchActivity(stream, setActive)
      return () => {
        unwatch()
        setActive(false)
      }
    }
    const devices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices
    if (deviceId === null || !devices?.getUserMedia) return
    let ended = false
    let release: (() => void) | null = null
    const open = (): void => {
      devices.getUserMedia({ audio: audioConstraint(deviceId) }).then(
        (opened) => {
          if (ended) {
            releaseStream(opened)
            return
          }
          const unwatch = watchActivity(opened, setActive)
          release = () => {
            unwatch()
            releaseStream(opened)
          }
        },
        () => {
          // Busy or gone: the icon stays as it is; adding or recording says why.
        }
      )
    }
    const timer = delayMs > 0 ? setTimeout(open, delayMs) : null
    if (timer === null) open()
    return () => {
      ended = true
      if (timer !== null) clearTimeout(timer)
      release?.()
      setActive(false)
    }
  }, [stream, deviceId, delayMs])

  return active
}
