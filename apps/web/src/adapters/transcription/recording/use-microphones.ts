import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_DEVICE_ID, microphoneChoices, type MicrophoneChoice } from './devices'

/**
 * The state of the device list: `loading` until the first enumeration, `unsupported` without
 * `navigator.mediaDevices` (an insecure origin, an old browser), `failed` when it threw.
 */
export type MicrophoneListState = 'loading' | 'ready' | 'unsupported' | 'failed'

export interface Microphones {
  list: MicrophoneListState
  choices: MicrophoneChoice[]
  /**
   * The main microphone: `DEFAULT_DEVICE_ID` for the browser's default input, `null` for none, when
   * regular recording takes only other sources.
   */
  selected: string | null
  /** `selected` as of now, also before the next render: for what resolves while a take starts. */
  latestSelected: () => string | null
  select: (deviceId: string | null) => void
  /** Whether the browser reports the microphone permission as granted. */
  granted: boolean
  /** After a successful `getUserMedia`: the permission is there and devices have labels now. */
  markGranted: () => void
}

function mediaDevices(): MediaDevices | undefined {
  return typeof navigator === 'undefined' ? undefined : navigator.mediaDevices
}

/**
 * Microphone permission and input devices after kiChat (T-55): checks the permission without
 * prompting, enumerates the inputs, follows permission changes and plugged or unplugged devices.
 * One selection serves regular recording and live transcription; the provider lets a selected
 * device that disappears go, as any other source.
 */
export function useMicrophones(): Microphones {
  const [list, setList] = useState<MicrophoneListState>(() =>
    mediaDevices()?.enumerateDevices ? 'loading' : 'unsupported'
  )
  const [choices, setChoices] = useState<MicrophoneChoice[]>([])
  const [selected, setSelected] = useState<string | null>(DEFAULT_DEVICE_ID)
  const selectedRef = useRef(selected)
  const select = useCallback((deviceId: string | null) => {
    selectedRef.current = deviceId
    setSelected(deviceId)
  }, [])
  const latestSelected = useCallback(() => selectedRef.current, [])
  const [granted, setGranted] = useState(false)
  const mounted = useRef(true)

  const refresh = useCallback((): Promise<void> => {
    const devices = mediaDevices()
    if (!devices?.enumerateDevices) return Promise.resolve()
    return devices.enumerateDevices().then(
      (found) => {
        if (!mounted.current) return
        const next = microphoneChoices(found)
        setChoices(next)
        setList('ready')
      },
      () => {
        if (mounted.current) setList('failed')
      }
    )
  }, [])

  useEffect(() => {
    mounted.current = true
    const devices = mediaDevices()
    if (!devices?.enumerateDevices) return
    void refresh()
    const onChange = (): void => void refresh()
    devices.addEventListener('devicechange', onChange)

    // Without prompting: whether the permission is there, and when it changes.
    let status: PermissionStatus | null = null
    const onPermission = (): void => {
      if (!status) return
      setGranted(status.state === 'granted')
      void refresh()
    }
    void navigator.permissions
      ?.query({ name: 'microphone' as PermissionName })
      .then((result) => {
        if (!mounted.current) return
        status = result
        setGranted(result.state === 'granted')
        result.addEventListener('change', onPermission)
      })
      .catch(() => {
        // Firefox before 131 and some WebViews know no microphone permission query.
      })

    return () => {
      mounted.current = false
      devices.removeEventListener('devicechange', onChange)
      status?.removeEventListener('change', onPermission)
    }
  }, [refresh])

  const markGranted = useCallback(() => {
    setGranted(true)
    void refresh()
  }, [refresh])

  return useMemo(
    () => ({ list, choices, selected, latestSelected, select, granted, markGranted }),
    [list, choices, selected, latestSelected, select, granted, markGranted]
  )
}
