import { Fragment, useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { ArrowDownIcon, ArrowUpIcon, EyeIcon, EyeOffIcon, PauseIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge, Button, Card, CardContent, Textarea } from '@ki4jlu/design-system'
import {
  TRANSCRIPTION_SEGMENT_TEXT_MAX,
  TRANSCRIPTION_SPEAKER_NAME_MAX,
  type TranscriptionSegment
} from '@justcampus/shared'
import { toast } from '@/lib/toast'
import {
  blockCopyText,
  draftSelection,
  formatTimestamp,
  isPlaceholder,
  moveSelection,
  moveTarget,
  needsSpace,
  redactSelection,
  removeRedaction,
  renameSpeaker,
  textPieces,
  updateSegmentText,
  type MoveDirection,
  type SpeakerBlock
} from '../segments'
import { BlockActions } from './block-actions'
import { CopyBlockButton } from './copy-button'
import { blockElementId } from './dom'
import { IconButton } from './icon-button'
import { NameInput } from './name-input'
import type { GlobalPlayerHandle } from './player'
import {
  isSelectionHandle,
  measureSelection,
  readSelection,
  type BlockSelection
} from './selection'
import { SelectionHandles, SelectionPopover } from './selection-ui'
import type { ResultSession, ResultState } from './session'
import { SpeakerDot } from './speaker-dot'
import { useSpeakerLabel } from './use-speaker-label'

/** Indents of the shown speakers by order of appearance, as kiChat's dynamic indentation. */
const INDENTS = ['', 'ml-2', 'ml-4', 'ml-6'] as const

interface TranscriptProps {
  session: ResultSession
  state: ResultState
  blocks: readonly SpeakerBlock[]
  /** The Corrections tab: editing, selection actions and block actions. */
  corrections: boolean
  /** The block the player is in, or -1. */
  activeBlock: number
  playing: boolean
  hasAudio: boolean
  player: RefObject<GlobalPlayerHandle | null>
}

interface RedactionTarget {
  block: number
  segment: number
  redaction: number
}

/**
 * The transcript as speaker blocks (T-25 to T-33), after kiChat's
 * `formatTranscriptionWithSpeakers`: each block has its speaker's colour, name and time, plays
 * from its avatar and seeks from its time, and can be copied. In the Corrections tab a segment's
 * text opens for editing on click (or Enter), selected text can be hidden or moved to the
 * neighbouring speaker, and the block's speaker can be changed.
 */
export function Transcript({
  session,
  state,
  blocks,
  corrections,
  activeBlock,
  playing,
  hasAudio,
  player
}: TranscriptProps): React.JSX.Element {
  const { t } = useTranslation()
  const speakerLabel = useSpeakerLabel()
  const area = useRef<HTMLOListElement>(null)
  const editor = useRef<HTMLTextAreaElement>(null)
  const editorDone = useRef(false)
  const keepSelection = useRef(false)
  /** The concealed range the toolbar offers to show again, for placing the toolbar. */
  const redactionElement = useRef<HTMLElement | null>(null)
  const [editing, setEditing] = useState<number | null>(null)
  const [renaming, setRenaming] = useState<number | null>(null)
  const [selection, setSelection] = useState<BlockSelection | null>(null)
  const [redaction, setRedaction] = useState<RedactionTarget | null>(null)
  const { segments, hidden, focused } = state

  // The document's selection in the transcript, as segment offsets (mouse and touch handles).
  useEffect(() => {
    if (!corrections) return
    let frame = 0
    const onChange = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const holder = area.current
        if (!holder) return
        // The open editor reports its own selection.
        if (document.activeElement === editor.current && editor.current) return
        const read = readSelection(window.getSelection(), holder, segments, blocks)
        if (!read && keepSelection.current) return
        setSelection((previous) => (sameSelection(previous, read) ? previous : read))
        if (read) {
          keepSelection.current = false
          setRedaction(null)
        }
      })
    }
    document.addEventListener('selectionchange', onChange)
    return () => {
      document.removeEventListener('selectionchange', onChange)
      cancelAnimationFrame(frame)
    }
  }, [corrections, segments, blocks])

  const startEditing = (index: number): void => {
    editorDone.current = false
    setSelection(null)
    setRedaction(null)
    setEditing(index)
  }

  /**
   * Saves the open editor's text (T-27); no undo step, as in kiChat. An emptied segment keeps
   * its placeholder, even beside text of the same speaker, so it can be filled in again.
   */
  const commitEditing = (refocus: boolean): void => {
    const index = editing
    const value = editor.current?.value
    if (index === null || editorDone.current) return
    editorDone.current = true
    if (value !== undefined) {
      session.edit(
        ({ segments: current }) => {
          const result = updateSegmentText(current, index, value)
          return result ? { segments: result } : null
        },
        { undoable: false, cleanup: false }
      )
      // A selection made in the editor now points into the saved text, without its line breaks.
      if (selection?.draft !== undefined) {
        const { start, end } = selection.bounds
        const bounds = draftSelection(
          session.getState().segments,
          start.segment,
          selection.draft,
          start.offset,
          end.offset
        )
        setSelection(bounds ? { block: selection.block, bounds } : null)
      }
    }
    setEditing(null)
    if (refocus) {
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(`[data-seg-edit="${index}"]`)?.focus()
      })
    }
  }

  const cancelEditing = (): void => {
    const index = editing
    editorDone.current = true
    setEditing(null)
    setSelection(null)
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-seg-edit="${index}"]`)?.focus()
    })
  }

  const clearSelection = (): void => {
    keepSelection.current = false
    setSelection(null)
    setRedaction(null)
    window.getSelection()?.removeAllRanges()
  }

  /**
   * Hides or moves the selected text (T-31, T-33), after saving an open editor's text: a selection
   * made there is taken over into the saved text, whose line breaks are gone. When nothing of it
   * is left to act on, the user is told instead of the toolbar just closing.
   */
  const selectionAction = (action: 'redact' | MoveDirection): void => {
    const current = selection
    if (!current) return
    if (editing !== null) commitEditing(false)
    const applied = session.edit(({ segments: latest, blocks: shown }) => {
      const { draft, bounds } = current
      const target =
        draft === undefined
          ? bounds
          : draftSelection(
              latest,
              bounds.start.segment,
              draft,
              bounds.start.offset,
              bounds.end.offset
            )
      if (!target) return null
      const result =
        action === 'redact'
          ? redactSelection(latest, target)
          : moveSelection(latest, shown, target, action)
      return result ? { segments: result } : null
    })
    clearSelection()
    if (!applied) toast({ variant: 'info', title: t('transcription.result.selectionNotApplied') })
  }

  /** Where the toolbar points: a concealed range, the open editor or the selection's first line. */
  const anchorRect = useCallback((): DOMRect | null => {
    if (redaction && redactionElement.current?.isConnected) {
      return redactionElement.current.getBoundingClientRect()
    }
    if (editing !== null && editor.current) return editor.current.getBoundingClientRect()
    const holder = area.current
    return holder ? (measureSelection(holder)?.first ?? null) : null
  }, [redaction, editing])

  const isInside = useCallback(
    (target: EventTarget | null): boolean =>
      isSelectionHandle(target) ||
      (target instanceof Node && Boolean(area.current?.contains(target))),
    []
  )

  /** Who a selection in a block would move to; offsets do not matter for that. */
  const targetOf = (current: BlockSelection, direction: MoveDirection): string | null => {
    const last = segments[current.bounds.end.segment]
    return moveTarget(
      segments,
      blocks,
      {
        start: { segment: current.bounds.start.segment, offset: 0 },
        end: { segment: current.bounds.end.segment, offset: last ? last.text.length : 0 }
      },
      direction
    )
  }

  if (blocks.length === 0) {
    // No segments: the whole text under a default person (T-25).
    return (
      <Card>
        <CardContent className="flex flex-col gap-stack-sm">
          <div className="flex items-center gap-2">
            <SpeakerDot colorId={1} />
            <span>{t('transcription.result.defaultPerson')}</span>
            <span aria-hidden="true">•</span>
            <span>[{formatTimestamp(0)}]</span>
          </div>
          <p className="m-0">{state.transcript.text}</p>
        </CardContent>
      </Card>
    )
  }

  // Visible speakers in order of appearance, for the indents.
  const order = new Map<string, number>()
  for (const block of blocks) {
    if (!hidden.has(block.speaker) && !order.has(block.speaker))
      order.set(block.speaker, order.size)
  }

  const selectedBlock = selection && editing === null ? blocks[selection.block] : undefined
  const handles = corrections && selection !== null && selectedBlock !== undefined

  return (
    <>
      <ol
        ref={area}
        aria-label={t('transcription.result.aiTranscriptLabel')}
        className="m-0 flex list-none flex-col gap-stack-md p-0"
      >
        {blocks.map((block) => {
          if (hidden.has(block.speaker)) return null
          const name = speakerLabel(block.speaker)
          const isActive = activeBlock === block.index
          const isPlaying = playing && isActive
          const first = segments[block.segmentIndices[0]!]
          const indent = INDENTS[Math.min(order.get(block.speaker) ?? 0, INDENTS.length - 1)]
          return (
            <li
              key={first ? first.id : block.index}
              id={blockElementId(block.index)}
              className={indent}
              aria-current={isActive ? 'true' : undefined}
            >
              <Card accent={isActive}>
                <CardContent className="flex flex-col gap-stack-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <IconButton
                      label={
                        isPlaying
                          ? t('transcription.result.pauseBlock')
                          : t('transcription.result.playBlock', {
                              name,
                              time: formatTimestamp(block.start)
                            })
                      }
                      disabled={!hasAudio}
                      onClick={() => {
                        if (isPlaying) player.current?.pause()
                        else if (corrections) player.current?.play(block.start, block.end)
                        else player.current?.play(block.start)
                      }}
                    >
                      {isPlaying ? (
                        <PauseIcon aria-hidden="true" className="size-4" />
                      ) : (
                        <SpeakerDot colorId={block.colorId} />
                      )}
                    </IconButton>
                    {corrections && renaming === block.index ? (
                      <NameInput
                        label={t('transcription.result.renameSpeaker')}
                        initial={name}
                        maxLength={TRANSCRIPTION_SPEAKER_NAME_MAX}
                        onSubmit={(value) => {
                          setRenaming(null)
                          session.edit(({ segments: latest, speakerColors, blocks: shown }) =>
                            renameSpeaker(
                              latest,
                              speakerColors,
                              block.speaker,
                              value,
                              shown
                                .filter((other) => other.speaker === block.speaker)
                                .flatMap((other) => other.segmentIndices)
                            )
                          )
                        }}
                        onCancel={() => setRenaming(null)}
                      />
                    ) : corrections ? (
                      <Button
                        type="button"
                        variant="ghost"
                        title={t('transcription.result.clickToRename')}
                        onClick={() => setRenaming(block.index)}
                      >
                        {name}
                      </Button>
                    ) : (
                      <span>{name}</span>
                    )}
                    <span aria-hidden="true">•</span>
                    <Button
                      type="button"
                      variant="link"
                      aria-label={t('transcription.result.seekTo', {
                        time: formatTimestamp(block.start)
                      })}
                      disabled={!hasAudio}
                      onClick={() => player.current?.seek(block.start)}
                    >
                      [{formatTimestamp(block.start)}]
                    </Button>
                    {focused === block.speaker ? (
                      <Badge tone="info" appearance="text" dot>
                        {t('transcription.result.selected')}
                      </Badge>
                    ) : null}
                    {corrections ? (
                      <BlockActions
                        session={session}
                        block={block}
                        blocks={blocks}
                        segments={segments}
                      />
                    ) : null}
                    <span className="ml-auto">
                      <CopyBlockButton
                        text={() =>
                          `${name}: ${blockCopyText(segments, block, t('transcription.result.emptySpeakerHint'))}`
                        }
                      />
                    </span>
                  </div>
                  <p className="m-0" data-block={block.index}>
                    {block.segmentIndices.map((index, position) => {
                      const segment = segments[index]
                      if (!segment) return null
                      const nextIndex = block.segmentIndices[position + 1]
                      const next = nextIndex === undefined ? undefined : segments[nextIndex]
                      const gap = next && needsSpace(segment.text, next.text) ? ' ' : ''
                      if (corrections && editing === index) {
                        return (
                          <Textarea
                            key={segment.id}
                            ref={editor}
                            aria-label={t('transcription.result.editText')}
                            defaultValue={isPlaceholder(segment.text) ? '' : segment.text}
                            placeholder={t('transcription.result.emptySpeakerHint')}
                            maxLength={TRANSCRIPTION_SEGMENT_TEXT_MAX}
                            rows={Math.max(2, Math.ceil(segment.text.length / 80))}
                            autoFocus
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault()
                                commitEditing(true)
                              } else if (event.key === 'Escape') {
                                event.preventDefault()
                                cancelEditing()
                              }
                            }}
                            onBlur={() => commitEditing(false)}
                            onSelect={(event) => {
                              const { selectionStart, selectionEnd, value } = event.currentTarget
                              setSelection(
                                selectionEnd > selectionStart
                                  ? {
                                      block: block.index,
                                      bounds: {
                                        start: { segment: index, offset: selectionStart },
                                        end: { segment: index, offset: selectionEnd }
                                      },
                                      draft: value
                                    }
                                  : null
                              )
                            }}
                          />
                        )
                      }
                      return (
                        <Fragment key={segment.id}>
                          <SegmentText
                            segment={segment}
                            index={index}
                            corrections={corrections}
                            placeholder={t('transcription.result.emptySpeakerHint')}
                            redactionLabel={t('transcription.result.redactionLabel')}
                            editLabel={t('transcription.result.editText')}
                            onEdit={() => startEditing(index)}
                            onRedaction={(redactionIndex, element) => {
                              window.getSelection()?.removeAllRanges()
                              setSelection(null)
                              redactionElement.current = element
                              setRedaction({
                                block: block.index,
                                segment: index,
                                redaction: redactionIndex
                              })
                            }}
                          />
                          {gap ? (
                            <span data-seg={index} data-gap="">
                              {gap}
                            </span>
                          ) : null}
                        </Fragment>
                      )
                    })}
                  </p>
                </CardContent>
              </Card>
            </li>
          )
        })}
      </ol>
      {corrections ? (
        <SelectionPopover
          open={selection !== null || redaction !== null}
          anchor={anchorRect}
          area={area}
          handles={handles}
          isInside={isInside}
          onPointerDown={() => {
            keepSelection.current = true
          }}
          onClose={clearSelection}
        >
          {redaction ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                const target = redaction
                session.edit(({ segments: latest }) => {
                  const result = removeRedaction(latest, target.segment, target.redaction)
                  return result ? { segments: result } : null
                })
                clearSelection()
              }}
            >
              <EyeIcon aria-hidden="true" className="size-4" />
              {t('transcription.common.show')}
            </Button>
          ) : selection ? (
            <>
              <Button
                type="button"
                variant="outline"
                title={t('transcription.result.redactSelection')}
                onClick={() => selectionAction('redact')}
              >
                <EyeOffIcon aria-hidden="true" className="size-4" />
                {t('transcription.common.hide')}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={!targetOf(selection, 'up')}
                onClick={() => selectionAction('up')}
              >
                <ArrowUpIcon aria-hidden="true" className="size-4" />
                {t('transcription.result.moveUp')}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={!targetOf(selection, 'down')}
                onClick={() => selectionAction('down')}
              >
                <ArrowDownIcon aria-hidden="true" className="size-4" />
                {t('transcription.result.moveDown')}
              </Button>
            </>
          ) : null}
        </SelectionPopover>
      ) : null}
      {handles && selection && selectedBlock ? (
        <SelectionHandles
          area={area}
          segments={segments}
          block={selectedBlock}
          bounds={selection.bounds}
        />
      ) : null}
    </>
  )
}

function sameSelection(a: BlockSelection | null, b: BlockSelection | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.block === b.block &&
    a.bounds.start.segment === b.bounds.start.segment &&
    a.bounds.start.offset === b.bounds.start.offset &&
    a.bounds.end.segment === b.bounds.end.segment &&
    a.bounds.end.offset === b.bounds.end.offset &&
    a.draft === b.draft
  )
}

interface SegmentTextProps {
  segment: TranscriptionSegment
  index: number
  corrections: boolean
  placeholder: string
  redactionLabel: string
  editLabel: string
  onEdit: () => void
  onRedaction: (redaction: number, element: HTMLElement) => void
}

/**
 * One segment's text: concealed ranges as a badge (T-33), the placeholder as its hint (T-30). In
 * correction mode a click that is not the end of a selection, or Enter, opens it for editing; a
 * click on a concealed range offers to show it again.
 */
function SegmentText({
  segment,
  index,
  corrections,
  placeholder,
  redactionLabel,
  editLabel,
  onEdit,
  onRedaction
}: SegmentTextProps): React.JSX.Element {
  const content = isPlaceholder(segment.text) ? (
    <em data-seg={index} data-placeholder="">
      {placeholder}
    </em>
  ) : (
    textPieces(segment.text, segment.redactions).map((piece) => {
      if (!piece.redacted) {
        return (
          <span key={piece.start} data-seg={index} data-start={piece.start}>
            {piece.text}
          </span>
        )
      }
      const position = segment.redactions.findIndex(
        (range) => range.start <= piece.start && range.end >= piece.end
      )
      return (
        // DS gap: no redaction mark; a neutral badge stands in for kiChat's grey bar and conceals the text.
        <Badge
          key={piece.start}
          tone="neutral"
          appearance="filled"
          data-seg={index}
          data-start={piece.start}
          data-end={piece.end}
          data-redacted=""
          title={redactionLabel}
          onClick={
            corrections
              ? (event) => {
                  event.stopPropagation()
                  onRedaction(Math.max(0, position), event.currentTarget)
                }
              : undefined
          }
        >
          {redactionLabel}
        </Badge>
      )
    })
  )

  if (!corrections) return <span data-seg={index}>{content}</span>
  return (
    <span
      data-seg={index}
      data-seg-edit={index}
      role="button"
      tabIndex={0}
      title={editLabel}
      onClick={() => {
        const current = window.getSelection()
        if (current && !current.isCollapsed && current.toString().trim() !== '') return
        onEdit()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onEdit()
        }
      }}
    >
      {content}
    </span>
  )
}
