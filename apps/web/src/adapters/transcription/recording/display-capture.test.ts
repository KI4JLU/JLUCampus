import { describe, expect, it, vi } from 'vitest'
import {
  DisplayCaptureError,
  displayLabel,
  displaySupport,
  isChromium,
  startDisplayCapture,
  type NavigatorInfo
} from './display-capture'

const CHROME_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
const EDGE_UA = `${CHROME_UA} Edg/141.0.0.0`
const FIREFOX_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0'
const SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15'
const IOS_CHROME_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1'

const media = { getDisplayMedia: () => undefined, getUserMedia: () => undefined }

function browser(userAgent: string, brands?: string[]): NavigatorInfo {
  return {
    userAgent,
    userAgentData: brands ? { brands: brands.map((brand) => ({ brand })) } : undefined,
    mediaDevices: media
  }
}

describe('isChromium', () => {
  it('trusts the client hints first', () => {
    expect(isChromium(browser(FIREFOX_UA, ['Chromium', 'Google Chrome']))).toBe(true)
    expect(isChromium(browser(CHROME_UA, ['Not A Brand']))).toBe(false)
  })

  it('falls back to the user agent', () => {
    expect(isChromium(browser(CHROME_UA))).toBe(true)
    expect(isChromium(browser(EDGE_UA))).toBe(true)
    expect(isChromium(browser(FIREFOX_UA))).toBe(false)
    expect(isChromium(browser(SAFARI_UA))).toBe(false)
    expect(isChromium(browser(IOS_CHROME_UA))).toBe(false)
  })
})

describe('displaySupport', () => {
  const web = { desktop: false, media: true }

  it('shares in Chromium browsers with display capture', () => {
    expect(displaySupport(browser(CHROME_UA, ['Chromium']), web)).toBe('supported')
  })

  it('refuses the desktop app, other browsers and missing APIs', () => {
    expect(displaySupport(browser(CHROME_UA, ['Chromium']), { desktop: true, media: true })).toBe(
      'desktop'
    )
    expect(displaySupport(browser(FIREFOX_UA), web)).toBe('browser')
    expect(
      displaySupport({ userAgent: CHROME_UA, mediaDevices: { getUserMedia: () => 1 } }, web)
    ).toBe('browser')
    expect(displaySupport(browser(CHROME_UA), { desktop: false, media: false })).toBe('browser')
    expect(displaySupport(undefined, web)).toBe('browser')
  })
})

describe('displayLabel', () => {
  it('takes the first label that names something, not an id', () => {
    expect(displayLabel('web-contents-media-stream://1234:5', 'Tab audio')).toBe('Tab audio')
    expect(displayLabel('screen:0:0', ' System Audio ')).toBe('System Audio')
    expect(displayLabel('BigBlueButton – Seminar', 'System Audio')).toBe('BigBlueButton – Seminar')
    expect(displayLabel('window:42:0', '', undefined)).toBeNull()
  })
})

describe('startDisplayCapture', () => {
  const track = (label = '', surface?: string): MediaStreamTrack =>
    ({
      label,
      readyState: 'live',
      stop: vi.fn(),
      getSettings: () => ({ displaySurface: surface })
    }) as unknown as MediaStreamTrack
  const stream = (audio: MediaStreamTrack[], video: MediaStreamTrack[] = []): MediaStream => {
    const tracks = [...video, ...audio]
    return {
      getAudioTracks: () => tracks.filter((entry) => audio.includes(entry)),
      getVideoTracks: () => tracks.filter((entry) => video.includes(entry)),
      getTracks: () => [...tracks],
      removeTrack: (removed: MediaStreamTrack) => tracks.splice(tracks.indexOf(removed), 1)
    } as unknown as MediaStream
  }
  const devices = (shared: Promise<MediaStream>): Pick<MediaDevices, 'getDisplayMedia'> => ({
    getDisplayMedia: vi.fn(() => shared)
  })

  it('asks at once and keeps only the audio of what was shared', async () => {
    const [audio, video] = [track('System Audio'), track('screen:0:0', 'monitor')]
    const shared = stream([audio], [video])
    const media = devices(Promise.resolve(shared))
    const start = startDisplayCapture(media)
    // In the click, before anything awaits.
    expect(media.getDisplayMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        video: true,
        systemAudio: 'include',
        selfBrowserSurface: 'exclude'
      })
    )
    const captured = await start.capture
    expect(captured).toMatchObject({ label: 'System Audio', surface: 'monitor' })
    expect(video.stop).toHaveBeenCalled()
    expect(captured.stream.getTracks()).toEqual([audio])
  })

  it('lets go of a surface without audio', async () => {
    const video = track('window:1:0', 'window')
    const start = startDisplayCapture(devices(Promise.resolve(stream([], [video]))))
    await expect(start.capture).rejects.toMatchObject({ failure: 'noAudio' })
    expect(video.stop).toHaveBeenCalled()
  })

  it('tells a closed picker from a failure', async () => {
    const dismissed = startDisplayCapture(
      devices(Promise.reject(new DOMException('Permission denied', 'NotAllowedError')))
    )
    await expect(dismissed.capture).rejects.toMatchObject({ failure: 'dismissed' })
    const failed = startDisplayCapture(devices(Promise.reject(new Error('busy'))))
    await expect(failed.capture).rejects.toBeInstanceOf(DisplayCaptureError)
    await expect(failed.capture).rejects.toMatchObject({ failure: 'failed' })
  })

  it('releases what comes after a cancel', async () => {
    const audio = track()
    let share: (shared: MediaStream) => void = () => undefined
    const start = startDisplayCapture(
      devices(
        new Promise<MediaStream>((resolve) => {
          share = resolve
        })
      )
    )
    const settled = start.capture.catch((error: unknown) => error)
    start.cancel()
    share(stream([audio]))
    expect(await settled).toMatchObject({ failure: 'cancelled' })
    expect(audio.stop).toHaveBeenCalled()
  })
})
