import { describe, expect, it } from 'vitest'
import { isChromium, meetingMimeType, meetingSupport, type NavigatorInfo } from './meeting-capture'

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

describe('meetingSupport', () => {
  const web = { desktop: false, media: true }

  it('records in Chromium browsers with tab capture', () => {
    expect(meetingSupport(browser(CHROME_UA, ['Chromium']), web)).toBe('supported')
  })

  it('refuses the desktop app, other browsers and missing APIs', () => {
    expect(meetingSupport(browser(CHROME_UA, ['Chromium']), { desktop: true, media: true })).toBe(
      'desktop'
    )
    expect(meetingSupport(browser(FIREFOX_UA), web)).toBe('browser')
    expect(
      meetingSupport({ userAgent: CHROME_UA, mediaDevices: { getUserMedia: () => 1 } }, web)
    ).toBe('browser')
    expect(meetingSupport(browser(CHROME_UA), { desktop: false, media: false })).toBe('browser')
    expect(meetingSupport(undefined, web)).toBe('browser')
  })
})

describe('meetingMimeType', () => {
  it('prefers Opus in WebM, then any WebM, else the browser default', () => {
    expect(meetingMimeType(() => true)).toBe('audio/webm;codecs=opus')
    expect(meetingMimeType((type) => type === 'audio/webm')).toBe('audio/webm')
    expect(meetingMimeType(() => false)).toBeUndefined()
  })
})
