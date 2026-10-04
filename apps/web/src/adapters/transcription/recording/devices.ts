/**
 * Microphone choices after kiChat's `renderLiveAudioDeviceOptions` (T-55): the browser's default
 * input first, then every input device the browser names an id for. Before the microphone
 * permission browsers list devices without ids (not selectable) and without labels, so unnamed
 * devices get a numbered fallback label.
 */

/** What the choices read of a `MediaDeviceInfo`. */
export interface DeviceInfo {
  deviceId: string
  kind: string
  label: string
}

export interface MicrophoneChoice {
  deviceId: string
  /** The browser's label; `null` while permission hides it. */
  label: string | null
  /** 1-based number among the choices, for the fallback label. */
  number: number
}

/** `''`: the browser's default input, whatever the system routes there. */
export const DEFAULT_DEVICE_ID = ''

export function microphoneChoices(devices: readonly DeviceInfo[]): MicrophoneChoice[] {
  return devices
    .filter((device) => device.kind === 'audioinput' && device.deviceId)
    .map((device, index) => ({
      deviceId: device.deviceId,
      label: device.label.trim() || null,
      number: index + 1
    }))
}

/**
 * The selection after the device list changed: a device that is gone falls back to the default
 * input. kiChat never picks the first device on its own, since that silently switched every later
 * session to, e.g., a laptop's built-in microphone.
 */
export function keepSelectedDevice(selected: string, choices: readonly MicrophoneChoice[]): string {
  if (selected === DEFAULT_DEVICE_ID) return selected
  return choices.some((choice) => choice.deviceId === selected) ? selected : DEFAULT_DEVICE_ID
}

/** The `audio` constraint of `getUserMedia` for a selection. */
export function audioConstraint(deviceId: string): MediaTrackConstraints | true {
  return deviceId === DEFAULT_DEVICE_ID ? true : { deviceId: { exact: deviceId } }
}
