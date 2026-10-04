/**
 * The browser permissions the renderer gets: the microphone for the transcription module's
 * recording and live transcription, and element fullscreen for its maximised live transcript. Only
 * the app's own main frame gets them, and only audio: no camera, no screen, nothing for embedded
 * sites. Everything else stays refused, as before.
 */

export interface PermissionQuery {
  permission: string
  /** The requesting frame's URL, or its origin. */
  url: string | undefined
  isMainFrame: boolean
  /** A request's media types (`audio`, `video`). */
  mediaTypes?: readonly string[]
  /** A check's media type (`audio`, `video`, `unknown`). */
  mediaType?: string
}

type IsRendererUrl = (url: string) => boolean

function fromApp(query: PermissionQuery, isRendererUrl: IsRendererUrl): boolean {
  return query.isMainFrame && query.url !== undefined && isRendererUrl(query.url)
}

/** A permission prompt (`getUserMedia`, `requestFullscreen`): granted without asking, or refused. */
export function allowPermissionRequest(
  query: PermissionQuery,
  isRendererUrl: IsRendererUrl
): boolean {
  if (!fromApp(query, isRendererUrl)) return false
  if (query.permission === 'fullscreen') return true
  if (query.permission !== 'media') return false
  const types = query.mediaTypes ?? []
  return types.length > 0 && types.every((type) => type === 'audio')
}

/**
 * A permission check without a prompt, e.g. whether `enumerateDevices` may name the microphones
 * and `navigator.permissions` reports the microphone as granted.
 */
export function allowPermissionCheck(
  query: PermissionQuery,
  isRendererUrl: IsRendererUrl
): boolean {
  if (!fromApp(query, isRendererUrl)) return false
  if (query.permission === 'fullscreen') return true
  return query.permission === 'media' && query.mediaType === 'audio'
}
