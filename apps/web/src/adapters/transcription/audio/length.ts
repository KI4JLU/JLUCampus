/** The length an audio element reported for the source it loaded; `Infinity` for recordings. */
export interface MediaLength {
  source: Blob | string
  duration: number
}

/**
 * The length of `source` in seconds once its media reported metadata, `0` before: the media's own,
 * else the decoded waveform's, else `fallback` (the time line's length of this file) when the media
 * reports none, as recordings may. Metadata of an earlier source does not count, so a player whose
 * file is switched knows no length, and is not seeked, until the new file's metadata arrived.
 */
export function sourceLength(
  source: Blob | string | null,
  media: MediaLength | null,
  waveformDuration: number | undefined,
  fallback: number | undefined
): number {
  if (!source || media?.source !== source) return 0
  const known = Number.isFinite(media.duration)
  return (known ? media.duration : 0) || waveformDuration || (known ? 0 : (fallback ?? 0))
}
