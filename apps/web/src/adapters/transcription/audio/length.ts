/**
 * One lifetime of the audio element's source: every source it is given, `null` (cleared) too,
 * starts a new load, also when an earlier source comes back.
 */
export interface SourceLoad {
  source: Blob | string | null
  id: number
}

/** The length the audio element reported in one load; `Infinity` for recordings. */
export interface MediaLength {
  load: number
  duration: number
}

/** The load for `source`: the current one while the source stays, else the next. */
export function nextLoad(current: SourceLoad, source: Blob | string | null): SourceLoad {
  return current.source === source ? current : { source, id: current.id + 1 }
}

/**
 * The length of the current load's source in seconds once its media reported metadata, `0`
 * before: the media's own, else the decoded waveform's, else `fallback` (the time line's length of
 * this file) when the media reports none, as recordings may. Metadata of an earlier load does not
 * count, also not of the same source, so a player whose file is switched or reloaded knows no
 * length, and is not seeked, until this load's metadata arrived.
 */
export function sourceLength(
  load: SourceLoad,
  media: MediaLength | null,
  waveformDuration: number | undefined,
  fallback: number | undefined
): number {
  if (!load.source || media?.load !== load.id) return 0
  const known = Number.isFinite(media.duration)
  return (known ? media.duration : 0) || waveformDuration || (known ? 0 : (fallback ?? 0))
}
