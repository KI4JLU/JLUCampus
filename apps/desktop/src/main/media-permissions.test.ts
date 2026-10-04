import { describe, expect, it } from 'vitest'
import { allowPermissionCheck, allowPermissionRequest } from './media-permissions'

// As in `index.ts`: `app://-` has no origin of its own in Node's URL.
const isRendererUrl = (value: string): boolean => {
  const url = new URL(value)
  return url.protocol === 'app:' && url.host === '-'
}
const app = { url: 'app://-/c/123', isMainFrame: true }

describe('allowPermissionRequest', () => {
  it('grants the microphone to the app', () => {
    expect(
      allowPermissionRequest({ ...app, permission: 'media', mediaTypes: ['audio'] }, isRendererUrl)
    ).toBe(true)
  })

  it('refuses the camera and requests without media types', () => {
    expect(
      allowPermissionRequest(
        { ...app, permission: 'media', mediaTypes: ['audio', 'video'] },
        isRendererUrl
      )
    ).toBe(false)
    expect(
      allowPermissionRequest({ ...app, permission: 'media', mediaTypes: [] }, isRendererUrl)
    ).toBe(false)
  })

  it('grants fullscreen for the live transcript', () => {
    expect(allowPermissionRequest({ ...app, permission: 'fullscreen' }, isRendererUrl)).toBe(true)
  })

  it('refuses everything to embedded sites and other origins', () => {
    expect(
      allowPermissionRequest(
        { ...app, isMainFrame: false, permission: 'media', mediaTypes: ['audio'] },
        isRendererUrl
      )
    ).toBe(false)
    expect(
      allowPermissionRequest(
        {
          url: 'https://example.org/',
          isMainFrame: true,
          permission: 'media',
          mediaTypes: ['audio']
        },
        isRendererUrl
      )
    ).toBe(false)
  })

  it('keeps refusing other permissions', () => {
    for (const permission of ['notifications', 'geolocation', 'display-capture', 'unknown'])
      expect(allowPermissionRequest({ ...app, permission }, isRendererUrl)).toBe(false)
  })
})

describe('allowPermissionCheck', () => {
  it('lets the app enumerate and query the microphone', () => {
    expect(
      allowPermissionCheck({ ...app, permission: 'media', mediaType: 'audio' }, isRendererUrl)
    ).toBe(true)
    expect(
      allowPermissionCheck(
        { ...app, url: 'app://-', permission: 'media', mediaType: 'audio' },
        isRendererUrl
      )
    ).toBe(true)
  })

  it('refuses cameras, unknown media and other frames', () => {
    expect(
      allowPermissionCheck({ ...app, permission: 'media', mediaType: 'video' }, isRendererUrl)
    ).toBe(false)
    expect(
      allowPermissionCheck({ ...app, permission: 'media', mediaType: 'unknown' }, isRendererUrl)
    ).toBe(false)
    expect(
      allowPermissionCheck(
        { url: undefined, isMainFrame: false, permission: 'media', mediaType: 'audio' },
        isRendererUrl
      )
    ).toBe(false)
  })
})
