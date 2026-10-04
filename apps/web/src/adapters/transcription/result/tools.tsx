import { useMemo, useState } from 'react'
import { EyeIcon, EyeOffIcon, PencilIcon, Undo2Icon, XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  PanelSection,
  Popover,
  PopoverContent,
  PopoverTrigger
} from '@ki4jlu/design-system'
import {
  TRANSCRIPTION_SPEAKER_COLOR_IDS,
  TRANSCRIPTION_SPEAKER_NAME_MAX,
  type TranscriptionSpeakerColorId
} from '@justcampus/shared'
import {
  blockSpeakers,
  buildSpeakerBlocks,
  clearRedactions,
  isSoloed,
  listRedactions,
  removeRedaction,
  renameSpeaker,
  setSpeakerColor,
  toggleSolo,
  type BlockSpeaker
} from '../segments'
import { useTranscriptionWorkspace } from '../use-workspace'
import { scrollToBlock } from './dom'
import { IconButton } from './icon-button'
import { NameInput } from './name-input'
import { useResultSession, useResultState, type ResultSession, type ResultState } from './session'
import { SpeakerDot } from './speaker-dot'
import { useSpeakerLabel } from './use-speaker-label'

/**
 * The side column of the Preview and Corrections tabs (T-26, T-28, T-33), after kiChat's speaker
 * panel and correction tools: every speaker with its colour, focus, solo and hide, in correction
 * mode also renaming and colours, and the list of redactions.
 */
export function ResultToolsPanel(): React.JSX.Element | null {
  const session = useResultSession()
  const { resultTab } = useTranscriptionWorkspace()
  if (!session) return null
  return <Tools key={session.id} session={session} corrections={resultTab === 'corrections'} />
}

function Tools({
  session,
  corrections
}: {
  session: ResultSession
  corrections: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const state = useResultState(session)
  const blocks = useMemo(
    () => buildSpeakerBlocks(state.segments, state.speakerColors).blocks,
    [state.segments, state.speakerColors]
  )
  const speakers = blockSpeakers(blocks)
  const names = speakers.map((speaker) => speaker.speaker)

  return (
    <>
      <PanelSection title={t('transcription.common.speakers')} aside={String(speakers.length)}>
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {speakers.map((speaker) => (
            <SpeakerRow
              key={speaker.speaker}
              session={session}
              state={state}
              speaker={speaker}
              names={names}
              blockSegments={blocks
                .filter((block) => block.speaker === speaker.speaker)
                .flatMap((block) => block.segmentIndices)}
              corrections={corrections}
            />
          ))}
        </ul>
        {state.hidden.size > 0 ? (
          <Button type="button" variant="outline" onClick={() => session.setHidden(new Set())}>
            <EyeIcon aria-hidden="true" className="size-4" />
            {t('transcription.result.showAllSpeakers')}
          </Button>
        ) : null}
      </PanelSection>
      {corrections ? <Redactions session={session} state={state} /> : null}
    </>
  )
}

interface SpeakerRowProps {
  session: ResultSession
  state: ResultState
  speaker: BlockSpeaker
  names: readonly string[]
  /** The segments of the speaker's blocks, for naming a speaker without a stored name. */
  blockSegments: readonly number[]
  corrections: boolean
}

function SpeakerRow({
  session,
  state,
  speaker,
  names,
  blockSegments,
  corrections
}: SpeakerRowProps): React.JSX.Element {
  const { t } = useTranslation()
  const speakerLabel = useSpeakerLabel()
  const [renaming, setRenaming] = useState(false)
  const name = speakerLabel(speaker.speaker)
  const isHidden = state.hidden.has(speaker.speaker)
  const soloed = isSoloed(names, state.hidden, speaker.speaker)
  const anySolo = names.some((other) => isSoloed(names, state.hidden, other))
  const focused = state.focused === speaker.speaker

  const toggleHidden = (): void => {
    const next = new Set(state.hidden)
    if (isHidden) next.delete(speaker.speaker)
    else next.add(speaker.speaker)
    session.setHidden(next)
  }

  const focus = (): void => {
    // While a speaker is soloed in the preview, choosing another solos that one instead.
    if (!corrections && anySolo) {
      session.setHidden(toggleSolo(names, state.hidden, speaker.speaker))
      return
    }
    const next = focused ? null : speaker.speaker
    session.setFocused(next)
    if (next) requestAnimationFrame(() => scrollToBlock(speaker.firstBlock, true))
  }

  return (
    <li className="flex min-w-0 items-center gap-1">
      {corrections ? (
        <ColorPicker
          name={name}
          colorId={speaker.colorId}
          onPick={(colorId) =>
            session.edit(
              ({ speakerColors }) => {
                const colors = setSpeakerColor(speakerColors, speaker.speaker, colorId)
                return colors ? { speakerColors: colors } : null
              },
              { undoable: false }
            )
          }
        />
      ) : (
        <IconButton
          label={
            soloed
              ? t('transcription.result.showAllSpeakers')
              : `${t('transcription.result.showOnlyThisSpeaker')}: ${name}`
          }
          aria-pressed={soloed}
          disabled={names.length < 2}
          onClick={() => session.setHidden(toggleSolo(names, state.hidden, speaker.speaker))}
        >
          <SpeakerDot colorId={speaker.colorId} />
        </IconButton>
      )}
      {renaming ? (
        <NameInput
          label={t('transcription.result.renameSpeaker')}
          initial={name}
          maxLength={TRANSCRIPTION_SPEAKER_NAME_MAX}
          onSubmit={(value) => {
            setRenaming(false)
            session.edit(({ segments, speakerColors }) =>
              renameSpeaker(segments, speakerColors, speaker.speaker, value, blockSegments)
            )
          }}
          onCancel={() => setRenaming(false)}
        />
      ) : (
        <>
          <Button
            type="button"
            variant="ghost"
            aria-pressed={focused}
            className="min-w-0 flex-1 justify-start"
            onClick={focus}
          >
            <span className="min-w-0 truncate">{name}</span>
          </Button>
          <IconButton
            label={`${
              isHidden
                ? t('transcription.result.showSpeaker')
                : t('transcription.result.hideSpeaker')
            }: ${name}`}
            aria-pressed={isHidden}
            onClick={toggleHidden}
          >
            {isHidden ? (
              <EyeOffIcon aria-hidden="true" className="size-4" />
            ) : (
              <EyeIcon aria-hidden="true" className="size-4" />
            )}
          </IconButton>
          {corrections ? (
            <IconButton
              label={`${t('transcription.result.renameSpeaker')}: ${name}`}
              onClick={() => setRenaming(true)}
            >
              <PencilIcon aria-hidden="true" className="size-4" />
            </IconButton>
          ) : null}
        </>
      )}
    </li>
  )
}

/** The ten avatar colours to choose from (T-28), after kiChat's avatar picker. */
function ColorPicker({
  name,
  colorId,
  onPick
}: {
  name: string
  colorId: TranscriptionSpeakerColorId
  onPick: (colorId: TranscriptionSpeakerColorId) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton label={`${t('transcription.common.changeColor')}: ${name}`}>
          <SpeakerDot colorId={colorId} />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="start" className="grid grid-cols-5 gap-1">
        {TRANSCRIPTION_SPEAKER_COLOR_IDS.map((option) => (
          <Button
            key={option}
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('transcription.result.colorN', { n: option })}
            aria-pressed={option === colorId}
            onClick={() => {
              onPick(option)
              setOpen(false)
            }}
          >
            <SpeakerDot colorId={option} />
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

/** The redactions of the transcript (T-33): each with its speaker, removable, or all at once. */
function Redactions({
  session,
  state
}: {
  session: ResultSession
  state: ResultState
}): React.JSX.Element {
  const { t } = useTranslation()
  const speakerLabel = useSpeakerLabel()
  const entries = listRedactions(state.segments)
  return (
    <PanelSection title={t('transcription.result.redactions')} aside={String(entries.length)}>
      {entries.length === 0 ? (
        <p className="m-0">{t('transcription.result.noRedactions')}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {entries.map((entry) => (
            <li
              key={`${entry.segment}-${entry.redaction}`}
              className="flex min-w-0 items-center gap-2"
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span>
                  {entry.speaker ? speakerLabel(entry.speaker) : t('transcription.common.unknown')}
                </span>
                <span className="break-words">
                  {t('transcription.result.redactedQuote', { text: entry.display })}
                </span>
              </span>
              <IconButton
                label={t('transcription.result.removeRedaction')}
                onClick={() =>
                  session.edit(({ segments }) => {
                    const result = removeRedaction(segments, entry.segment, entry.redaction)
                    return result ? { segments: result } : null
                  })
                }
              >
                <XIcon aria-hidden="true" className="size-4" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        {entries.length > 0 ? (
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              session.edit(({ segments }) => {
                const result = clearRedactions(segments)
                return result ? { segments: result } : null
              })
            }
          >
            {t('transcription.result.clearRedactions')}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          disabled={state.undo.length === 0}
          onClick={() => session.undo()}
        >
          <Undo2Icon aria-hidden="true" className="size-4" />
          {t('transcription.result.undoAction')}
        </Button>
      </div>
    </PanelSection>
  )
}
