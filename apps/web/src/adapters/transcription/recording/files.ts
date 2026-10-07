/**
 * Recorded takes as files: they keep the recorder's own format (Chrome and Firefox record
 * Opus/WebM, Safari MP4), named and typed after what the recorder actually wrote. One format is
 * never labelled as another (T-57).
 */

/** Opus in WebM where the recorder offers it, else WebM in the browser's default codec. */
export function recorderMimeType(isTypeSupported: (type: string) => boolean): string | undefined {
  return ['audio/webm;codecs=opus', 'audio/webm'].find((type) => isTypeSupported(type))
}

/** Mono speech; about 22 MB an hour. */
export const RECORDING_AUDIO_BITS_PER_SECOND = 48_000

/** A take's file extension and type. */
export interface RecordingFormat {
  extension: 'webm' | 'm4a' | 'ogg'
  /** Without codecs, as the upload checks it. */
  type: 'audio/webm' | 'audio/mp4' | 'audio/ogg'
}

/**
 * The file format of what a recorder of `mimeType` wrote; `null` for a format the upload does not
 * take. An empty type, which a recorder only reports before it started, counts as WebM.
 */
export function recordingFormat(mimeType: string): RecordingFormat | null {
  const type = mimeType.trim().toLowerCase()
  if (type === '' || /^(?:audio|video)\/webm\b/.test(type))
    return { extension: 'webm', type: 'audio/webm' }
  if (/^(?:audio|video)\/(?:mp4|x-m4a|aac)\b/.test(type))
    return { extension: 'm4a', type: 'audio/mp4' }
  if (/^(?:audio|video)\/ogg\b/.test(type)) return { extension: 'ogg', type: 'audio/ogg' }
  return null
}

/**
 * The name kiChat gives a take, `<username>-YYYYMMDD-HHMMSS.<extension>`, in local time of the
 * moment the recording started.
 */
export function recordingFilename(username: string, startedAt: Date, extension: string): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const date = `${startedAt.getFullYear()}${pad(startedAt.getMonth() + 1)}${pad(startedAt.getDate())}`
  const time = `${pad(startedAt.getHours())}${pad(startedAt.getMinutes())}${pad(startedAt.getSeconds())}`
  return `${username}-${date}-${time}.${extension}`
}

/**
 * The user name in a take's filename. Campus knows no account name, so the local part of the
 * e-mail address stands in for kiChat's username, else the display name; characters a filename
 * should not carry become `-`. `user` when nothing is left, as in kiChat.
 */
export function recordingUsername(
  user: { email?: string | null; name?: string | null } | null
): string {
  const candidates = [user?.email?.split('@')[0], user?.name]
  for (const candidate of candidates) {
    const cleaned = (candidate ?? '')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
    if (cleaned) return cleaned.slice(0, 64)
  }
  return 'user'
}

/** A take's size as kiChat writes it in the status: `1.2 MB`, below a megabyte `340 KB`. */
export function formatFileSize(bytes: number): string {
  if (!bytes) return '0 KB'
  const megabytes = bytes / (1024 * 1024)
  if (megabytes >= 1) return `${megabytes.toFixed(1)} MB`
  return `${Math.ceil(bytes / 1024)} KB`
}
