/**
 * The detail of a transcript as it may arrive (T-39): kiChat's server sent `segments` either as an
 * array or as the JSON text of that array (`Utils.normalizeSegments`). This turns the text into
 * the array before the payload is validated; anything else stays as it is, for the schema to judge.
 */
export function withParsedSegments(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw
  const segments = (raw as { segments?: unknown }).segments
  if (typeof segments !== 'string') return raw
  let parsed: unknown
  try {
    parsed = JSON.parse(segments)
  } catch {
    return raw
  }
  return Array.isArray(parsed) ? { ...raw, segments: parsed } : raw
}
