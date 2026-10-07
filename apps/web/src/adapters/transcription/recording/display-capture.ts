import { desktopBridge } from '@/desktop/bridge'
import { releaseStream } from './local-recorder'

/**
 * A tab, window or screen as a recording source, through `getDisplayMedia`: only Chromium
 * browsers share a surface's audio there (a tab's own, or the system's with a whole screen;
 * windows bring none). The desktop app has no display-media handler.
 */

/** Why no tab, window or screen can be added here; `supported` when it can. */
export type DisplaySupport = 'supported' | 'browser' | 'desktop'

/** What the support check reads of `navigator`. */
export interface NavigatorInfo {
  userAgent: string
  userAgentData?: { brands?: readonly { brand: string }[] }
  mediaDevices?: { getDisplayMedia?: unknown; getUserMedia?: unknown }
}

/** Chrome, Edge and other Chromium browsers; by their client hints, else by the user agent. */
export function isChromium(info: NavigatorInfo): boolean {
  const brands = info.userAgentData?.brands
  if (brands && brands.length > 0) return brands.some((entry) => entry.brand === 'Chromium')
  // Edge and Opera name Chrome too; Chrome on iOS (`CriOS`) is WebKit and does not.
  return /\b(?:Chrome|Chromium)\/\d/.test(info.userAgent)
}

export function displaySupport(
  info: NavigatorInfo | undefined,
  { desktop, media }: { desktop: boolean; media: boolean }
): DisplaySupport {
  if (desktop) return 'desktop'
  if (
    !info ||
    !media ||
    !isChromium(info) ||
    typeof info.mediaDevices?.getDisplayMedia !== 'function' ||
    typeof info.mediaDevices.getUserMedia !== 'function'
  )
    return 'browser'
  return 'supported'
}

/** Whether this browser can add a tab, window or screen to a recording. */
export function detectDisplaySupport(): DisplaySupport {
  return displaySupport(typeof navigator === 'undefined' ? undefined : navigator, {
    desktop: desktopBridge() !== undefined,
    media: typeof MediaRecorder !== 'undefined' && typeof AudioContext !== 'undefined'
  })
}

/** What was shared: a tab, a window or a whole screen. */
export type DisplaySurface = 'browser' | 'window' | 'monitor'

/** Chrome's options of `getDisplayMedia` beyond the standard dictionary. */
interface DisplayCaptureOptions {
  video: boolean
  audio: MediaTrackConstraints & { suppressLocalAudioPlayback?: boolean }
  selfBrowserSurface: 'include' | 'exclude'
  systemAudio: 'include' | 'exclude'
  surfaceSwitching: 'include' | 'exclude'
}

/**
 * Any surface with its audio: video is required, then dropped. The picker leaves out this tab,
 * offers the system's audio with a whole screen, keeps the shared audio audible here, and lets the
 * user switch to another tab while sharing.
 */
const DISPLAY_CAPTURE: DisplayCaptureOptions = {
  video: true,
  audio: { suppressLocalAudioPlayback: false },
  selfBrowserSurface: 'exclude',
  systemAudio: 'include',
  surfaceSwitching: 'include'
}

/**
 * Why sharing gave no source: `cancelled` by `cancel`, `dismissed` when the user closed the
 * picker, `noAudio` for a surface without sound (a window, or "Share tab audio" unticked).
 */
export type DisplayCaptureFailure = 'cancelled' | 'dismissed' | 'noAudio' | 'failed'

export class DisplayCaptureError extends Error {
  constructor(
    readonly failure: DisplayCaptureFailure,
    readonly reason: unknown
  ) {
    super(failure)
    this.name = 'DisplayCaptureError'
  }
}

/** A shared surface's audio. */
export interface DisplayAudio {
  /** The audio tracks alone; stopping them ends the sharing. */
  stream: MediaStream
  /** The surface's name, where the browser gives one rather than an id. */
  label: string | null
  surface: DisplaySurface | null
}

/** A capture on its way: the browser's picker may still be open. */
export interface DisplayCaptureStart {
  capture: Promise<DisplayAudio>
  /** Gives the capture up: what comes is released, and `capture` rejects as `cancelled`. */
  cancel: () => void
}

/** Labels browsers give a surface by its id rather than its name. */
const ID_LABEL = /^(?:screen|window|web-contents-media-stream):/i

/** The first of `labels` that names something; `null` when none does. */
export function displayLabel(...labels: (string | undefined)[]): string | null {
  for (const label of labels) {
    const trimmed = label?.trim()
    if (trimmed && !ID_LABEL.test(trimmed)) return trimmed
  }
  return null
}

function surfaceOf(value: unknown): DisplaySurface | null {
  return value === 'browser' || value === 'window' || value === 'monitor' ? value : null
}

/**
 * Asks for a tab, window or screen with its audio. Call it straight from the click, before
 * anything awaits: Chrome only opens the picker with the click's transient activation.
 */
export function startDisplayCapture(
  devices: Pick<MediaDevices, 'getDisplayMedia'>
): DisplayCaptureStart {
  const controller = new AbortController()
  let display: Promise<MediaStream>
  try {
    display = devices.getDisplayMedia(DISPLAY_CAPTURE as DisplayMediaStreamOptions)
  } catch (error) {
    display = Promise.reject(error instanceof Error ? error : new Error(String(error)))
  }
  return { capture: displayAudio(display, controller.signal), cancel: () => controller.abort() }
}

async function displayAudio(
  display: Promise<MediaStream>,
  signal: AbortSignal
): Promise<DisplayAudio> {
  let shared: MediaStream
  try {
    shared = await display
  } catch (error) {
    if (signal.aborted) throw new DisplayCaptureError('cancelled', null)
    const dismissed = error instanceof Error && error.name === 'NotAllowedError'
    throw new DisplayCaptureError(dismissed ? 'dismissed' : 'failed', error)
  }
  if (signal.aborted) {
    releaseStream(shared)
    throw new DisplayCaptureError('cancelled', null)
  }
  const [video] = shared.getVideoTracks()
  const audio = shared.getAudioTracks()
  const surface = surfaceOf(video?.getSettings().displaySurface)
  const label = displayLabel(video?.label, audio[0]?.label)
  // Only the sound is recorded; the picture would just cost.
  for (const track of shared.getVideoTracks()) {
    track.stop()
    shared.removeTrack(track)
  }
  if (audio.length === 0) {
    releaseStream(shared)
    throw new DisplayCaptureError('noAudio', null)
  }
  return { stream: shared, label, surface }
}
