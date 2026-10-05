import {
  TRANSCRIPT_PRESETS,
  TRANSCRIPTION_FORMAT_NAME_MAX,
  type TranscriptFormatFlags,
  type TranscriptionFormat,
  type TranscriptPresetId
} from '@justcampus/shared'

/**
 * Transcript formats (T-44, T-45): kiChat's five presets, the user's saved formats, or `custom`
 * once a setting differs from the chosen one.
 */
export type TranscriptFormatChoice =
  { kind: 'preset'; id: TranscriptPresetId } | { kind: 'saved'; id: string } | { kind: 'custom' }

/** The flags of a preset or saved format. */
export function flagsOf(source: TranscriptFormatFlags): TranscriptFormatFlags {
  return {
    speakers: source.speakers,
    timestamps: source.timestamps,
    avatars: source.avatars,
    bubbles: source.bubbles,
    anonymize: source.anonymize,
    order: source.order
  }
}

export function presetFlags(id: TranscriptPresetId): TranscriptFormatFlags {
  return flagsOf(TRANSCRIPT_PRESETS[id])
}

/** Whether a choice is the one shown as active. */
export function isChoice(choice: TranscriptFormatChoice, other: TranscriptFormatChoice): boolean {
  if (choice.kind !== other.kind) return false
  return choice.kind === 'custom' || choice.id === (other as { id: string }).id
}

/**
 * The name a saved format gets (T-45): the trimmed name, and if another of the user's formats
 * already has it in any case, ` (1)`, ` (2)` … until it is free, the name shortened where the
 * suffix would pass the length limit, as the server does. The format being changed does not count
 * against its own name. `null` for a blank name.
 */
export function uniqueFormatName(
  name: string,
  formats: readonly Pick<TranscriptionFormat, 'id' | 'name'>[],
  editingId: string | null
): string | null {
  const base = name.trim()
  if (!base) return null
  const taken = (candidate: string): boolean =>
    formats.some(
      (format) => format.id !== editingId && format.name.toLowerCase() === candidate.toLowerCase()
    )
  let result = base
  for (let counter = 1; taken(result); counter++) {
    const suffix = ` (${counter})`
    result = `${base.slice(0, TRANSCRIPTION_FORMAT_NAME_MAX - suffix.length).trimEnd()}${suffix}`
  }
  return result
}

/** The texts of a saved format's summary line. */
export interface FormatDetailLabels {
  names: string
  timestamps: string
  avatars: string
  bubbles: string
  anonymised: string
  chronological: string
  bySpeaker: string
}

/** `Namen · Zeitstempel · … · chronologisch`, the line under a saved format. */
export function formatDetails(flags: TranscriptFormatFlags, labels: FormatDetailLabels): string {
  const details: string[] = []
  if (flags.speakers) details.push(labels.names)
  if (flags.timestamps) details.push(labels.timestamps)
  if (flags.avatars) details.push(labels.avatars)
  if (flags.bubbles) details.push(labels.bubbles)
  if (flags.anonymize) details.push(labels.anonymised)
  details.push(flags.order === 'chronological' ? labels.chronological : labels.bySpeaker)
  return details.join(' · ')
}
