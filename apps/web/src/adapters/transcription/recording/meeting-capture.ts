import { desktopBridge } from '@/desktop/bridge'
import { releaseStream } from './local-recorder'

/**
 * Meeting recording: the user's microphone and the audio of another browser tab (e.g. a
 * BigBlueButton meeting), mixed down to one mono track and recorded as Opus/WebM. Only Chromium
 * browsers share a tab's audio through `getDisplayMedia`; the desktop app has no display-media
 * handler.
 */

/** Why the meeting tab cannot record here; `supported` when it can. */
export type MeetingSupport = 'supported' | 'browser' | 'desktop'

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

export function meetingSupport(
  info: NavigatorInfo | undefined,
  { desktop, media }: { desktop: boolean; media: boolean }
): MeetingSupport {
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

/** Whether this browser can record a meeting tab. */
export function detectMeetingSupport(): MeetingSupport {
  return meetingSupport(typeof navigator === 'undefined' ? undefined : navigator, {
    desktop: desktopBridge() !== undefined,
    media: typeof MediaRecorder !== 'undefined' && typeof AudioContext !== 'undefined'
  })
}

/** Opus in WebM where the recorder offers it, else WebM in the browser's default codec. */
export function meetingMimeType(isTypeSupported: (type: string) => boolean): string | undefined {
  return ['audio/webm;codecs=opus', 'audio/webm'].find((type) => isTypeSupported(type))
}

/** Mono speech; about 22 MB an hour. */
export const MEETING_AUDIO_BITS_PER_SECOND = 48_000

/** The type of a meeting take, whatever codec the recorder named. */
export const MEETING_FILE_TYPE = 'audio/webm'

/** Chrome's options of `getDisplayMedia` beyond the standard dictionary. */
interface TabCaptureOptions {
  video: MediaTrackConstraints & { displaySurface?: 'browser' | 'window' | 'monitor' }
  audio: MediaTrackConstraints & { suppressLocalAudioPlayback?: boolean }
  selfBrowserSurface: 'include' | 'exclude'
  systemAudio: 'include' | 'exclude'
  preferCurrentTab: boolean
  surfaceSwitching: 'include' | 'exclude'
}

/**
 * A tab with its audio: the picker opens on tabs (video is required, then dropped), leaves out
 * this tab and the whole system's audio, keeps the meeting audible here, and lets the user switch
 * to another tab while sharing.
 */
const TAB_CAPTURE: TabCaptureOptions = {
  video: { displaySurface: 'browser' },
  audio: { suppressLocalAudioPlayback: false },
  selfBrowserSurface: 'exclude',
  systemAudio: 'exclude',
  preferCurrentTab: false,
  surfaceSwitching: 'include'
}

/** Where starting a meeting failed; `cancelled` by `cancel`, e.g. as the page went away. */
export type MeetingCaptureFailure = 'display' | 'noTabAudio' | 'microphone' | 'audio' | 'cancelled'

export class MeetingCaptureError extends Error {
  constructor(
    readonly failure: MeetingCaptureFailure,
    readonly reason: unknown
  ) {
    super(failure)
    this.name = 'MeetingCaptureError'
  }
}

export interface MeetingCapture {
  /** One mono track: the microphone and the tab, mixed. */
  stream: MediaStream
  /** The tab's audio and the microphone; either ending (sharing stopped, device gone) ends the take. */
  sources: MediaStreamTrack[]
  /** Stops the microphone and the sharing and closes the mix; repeated calls do nothing. */
  release: () => void
}

/** A meeting capture on its way: the tab picker and the microphone prompt may still be open. */
export interface MeetingCaptureStart {
  capture: Promise<MeetingCapture>
  /**
   * Gives up the start: what was granted so far is released at once, what comes later as it
   * comes, and `capture` rejects as `cancelled`. Nothing once the capture is there.
   */
  cancel: () => void
}

/**
 * Asks for the meeting's tab, then the microphone, and mixes both. Call it straight from the
 * click, before anything awaits: Chrome only opens the tab picker with the click's transient
 * activation, which lasts a few seconds and would be gone after the microphone prompt, while
 * `getUserMedia` needs none. The `AudioContext` is created in the click too, so it runs without
 * a resume. `onTabShared` reports that the tab came and the microphone is asked for.
 */
export function startMeetingCapture(
  devices: MediaDevices,
  microphone: MediaTrackConstraints,
  onTabShared: () => void
): MeetingCaptureStart {
  const controller = new AbortController()
  const cancel = (): void => controller.abort()
  let context: AudioContext
  let display: Promise<MediaStream>
  try {
    context = new AudioContext({ latencyHint: 'playback' })
  } catch (error) {
    return { capture: Promise.reject(new MeetingCaptureError('audio', error)), cancel }
  }
  try {
    display = devices.getDisplayMedia(TAB_CAPTURE as DisplayMediaStreamOptions)
  } catch (error) {
    display = Promise.reject(error instanceof Error ? error : new Error(String(error)))
  }
  return {
    capture: connectMeeting(context, display, devices, microphone, onTabShared, controller.signal),
    cancel
  }
}

async function connectMeeting(
  context: AudioContext,
  display: Promise<MediaStream>,
  devices: MediaDevices,
  microphone: MediaTrackConstraints,
  onTabShared: () => void,
  signal: AbortSignal
): Promise<MeetingCapture> {
  let tab: MediaStream | null = null
  let mic: MediaStream | null = null
  const nodes: AudioNode[] = []
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    for (const node of nodes) node.disconnect()
    releaseStream(tab)
    releaseStream(mic)
    void context.close().catch(() => undefined)
  }
  // The tab's sharing ends at once, not only after the microphone prompt was answered.
  signal.addEventListener('abort', release, { once: true })
  /** After each wait: a start cancelled meanwhile lets go of what just came, too. */
  const ensureWanted = (): void => {
    if (!signal.aborted) return
    releaseStream(tab)
    releaseStream(mic)
    throw new MeetingCaptureError('cancelled', null)
  }

  try {
    try {
      tab = await display
    } catch (error) {
      ensureWanted()
      throw new MeetingCaptureError('display', error)
    }
    ensureWanted()
    // Only the sound is recorded; the picture would just cost.
    for (const track of tab.getVideoTracks()) track.stop()
    const tabAudio = tab.getAudioTracks()[0]
    // A window or screen, or "Share tab audio" left unticked.
    if (!tabAudio) throw new MeetingCaptureError('noTabAudio', null)
    onTabShared()

    try {
      mic = await devices.getUserMedia({ audio: microphone })
    } catch (error) {
      ensureWanted()
      throw new MeetingCaptureError('microphone', error)
    }
    ensureWanted()
    // Sharing stopped while the microphone was asked for; its `ended` came before any listener.
    if (tabAudio.readyState === 'ended')
      throw new MeetingCaptureError('display', new DOMException('Sharing ended', 'NotAllowedError'))

    try {
      // Explicit mono with the speakers downmix: a stereo tab becomes (L + R) / 2.
      const destination = context.createMediaStreamDestination()
      destination.channelCount = 1
      destination.channelCountMode = 'explicit'
      destination.channelInterpretation = 'speakers'
      // Never to `context.destination`: the user would hear the meeting twice.
      for (const stream of [mic, new MediaStream([tabAudio])]) {
        const source = context.createMediaStreamSource(stream)
        source.connect(destination)
        nodes.push(source)
      }
      nodes.push(destination)
      // Created in the click it runs already; a browser that started it suspended may resume it.
      if (context.state === 'suspended') await context.resume()
      ensureWanted()
      return {
        stream: destination.stream,
        sources: [tabAudio, ...mic.getAudioTracks()],
        release
      }
    } catch (error) {
      if (error instanceof MeetingCaptureError) throw error
      ensureWanted()
      throw new MeetingCaptureError('audio', error)
    }
  } catch (error) {
    release()
    throw error
  } finally {
    signal.removeEventListener('abort', release)
  }
}
