import { describe, expect, it } from 'vitest'
import {
  audioConstraint,
  DEFAULT_DEVICE_ID,
  keepSelectedDevice,
  microphoneChoices,
  type DeviceInfo
} from './devices'

const devices: DeviceInfo[] = [
  { deviceId: 'cam', kind: 'videoinput', label: 'Camera' },
  { deviceId: 'a', kind: 'audioinput', label: 'Headset' },
  { deviceId: '', kind: 'audioinput', label: '' },
  { deviceId: 'b', kind: 'audioinput', label: ' ' },
  { deviceId: 'out', kind: 'audiooutput', label: 'Speakers' }
]

describe('microphoneChoices', () => {
  it('lists input devices with an id and numbers them for fallback labels', () => {
    expect(microphoneChoices(devices)).toEqual([
      { deviceId: 'a', label: 'Headset', number: 1 },
      { deviceId: 'b', label: null, number: 2 }
    ])
  })

  it('offers nothing but the default before the permission names ids', () => {
    expect(microphoneChoices([{ deviceId: '', kind: 'audioinput', label: '' }])).toEqual([])
  })
})

describe('keepSelectedDevice', () => {
  const choices = microphoneChoices(devices)

  it('keeps a device that is still there', () => {
    expect(keepSelectedDevice('b', choices)).toBe('b')
  })

  it('falls back to the default input when the device disappeared', () => {
    expect(keepSelectedDevice('gone', choices)).toBe(DEFAULT_DEVICE_ID)
    expect(keepSelectedDevice(DEFAULT_DEVICE_ID, [])).toBe(DEFAULT_DEVICE_ID)
  })
})

describe('audioConstraint', () => {
  it('asks for exactly the chosen device, or any for the default, with the browser’s processing', () => {
    const processing = { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    expect(audioConstraint(DEFAULT_DEVICE_ID)).toEqual(processing)
    expect(audioConstraint('a')).toEqual({ ...processing, deviceId: { exact: 'a' } })
  })
})
