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
 * The `audio` constraint of `getUserMedia` for a selection: with the browser's echo cancellation,
 * noise suppression and gain control asked for explicitly, as live transcription hears the room.
 */
export function audioConstraint(deviceId: string): MediaTrackConstraints {
  const processing = { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  return deviceId === DEFAULT_DEVICE_ID
    ? processing
    : { ...processing, deviceId: { exact: deviceId } }
}
