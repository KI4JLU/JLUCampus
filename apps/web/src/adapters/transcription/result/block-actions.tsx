import { useRef, useState, type ReactNode } from 'react'
import {
  ArrowDownToLineIcon,
  ArrowUpToLineIcon,
  PlusIcon,
  Trash2Icon,
  UsersIcon
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Label,
  Popover,
  PopoverAnchor,
  PopoverContent
} from '@ki4jlu/design-system'
import { TRANSCRIPTION_SPEAKER_NAME_MAX, type TranscriptionSegment } from '@justcampus/shared'
import { toast } from '@/lib/toast'
import {
  insertOptions,
  insertSpeakerBlock,
  reassignBlock,
  reassignOptions,
  removeBlockSpeaker,
  type InsertPosition,
  type SpeakerBlock
} from '../segments'
import { IconButton } from './icon-button'
import { NameInput } from './name-input'
import type { ResultSession } from './session'
import { useSpeakerLabel } from './use-speaker-label'

type BlockAction = 'assign' | InsertPosition

interface BlockActionsProps {
  session: ResultSession
  block: SpeakerBlock
  blocks: readonly SpeakerBlock[]
  segments: readonly TranscriptionSegment[]
}

/**
 * A block's correction actions (T-29, T-30), after kiChat's speaker-edit buttons: assign the
 * block to another or a new speaker, insert a speaker before or after it, remove its speaker.
 * A new speaker's name is asked for in a small panel at the buttons.
 */
export function BlockActions({
  session,
  block,
  blocks,
  segments
}: BlockActionsProps): React.JSX.Element {
  const { t } = useTranslation()
  const [creating, setCreating] = useState<BlockAction | null>(null)

  const apply = (action: BlockAction, speaker: string): void => {
    session.edit(({ segments: current, blocks: shown }) => {
      const target = shown[block.index]
      if (!target) return null
      const result =
        action === 'assign'
          ? reassignBlock(current, target, speaker)
          : insertSpeakerBlock(current, shown, block.index, action, speaker)
      return result ? { segments: result } : null
    })
  }

  const remove = (): void => {
    const removed = session.edit(({ segments: current, blocks: shown }) => {
      const result = removeBlockSpeaker(current, shown, block.index)
      return result ? { segments: result } : null
    })
    if (!removed && blocks.length <= 1) {
      toast({ variant: 'info', title: t('transcription.result.onlyBlockRefused') })
    }
  }

  return (
    <Popover
      open={creating !== null}
      onOpenChange={(open) => (open ? undefined : setCreating(null))}
    >
      <PopoverAnchor asChild>
        <div className="flex flex-wrap items-center gap-1">
          <SpeakerMenu
            icon={<UsersIcon aria-hidden="true" className="size-4" />}
            label={t('transcription.result.assignTo')}
            heading={t('transcription.result.assignToColon')}
            options={reassignOptions(blocks, block)}
            onPick={(speaker) => apply('assign', speaker)}
            onNew={() => setCreating('assign')}
          />
          <SpeakerMenu
            icon={<ArrowUpToLineIcon aria-hidden="true" className="size-4" />}
            label={t('transcription.result.insertSpeakerBefore')}
            heading={t('transcription.result.insertSpeakerBeforeColon')}
            options={insertOptions(segments, block)}
            onPick={(speaker) => apply('above', speaker)}
            onNew={() => setCreating('above')}
          />
          <SpeakerMenu
            icon={<ArrowDownToLineIcon aria-hidden="true" className="size-4" />}
            label={t('transcription.result.insertSpeakerAfter')}
            heading={t('transcription.result.insertSpeakerAfterColon')}
            options={insertOptions(segments, block)}
            onPick={(speaker) => apply('below', speaker)}
            onNew={() => setCreating('below')}
          />
          <IconButton label={t('transcription.result.removeSpeakerAssignment')} onClick={remove}>
            <Trash2Icon aria-hidden="true" className="size-4" />
          </IconButton>
        </div>
      </PopoverAnchor>
      <PopoverContent align="start" className="flex flex-col gap-2">
        {creating ? (
          <>
            <Label>{t('transcription.result.newSpeaker')}</Label>
            <NameInput
              label={t('transcription.result.newSpeaker')}
              placeholder={t('transcription.result.namePlaceholderShort')}
              maxLength={TRANSCRIPTION_SPEAKER_NAME_MAX}
              onSubmit={(name) => {
                apply(creating, name)
                setCreating(null)
              }}
              onCancel={() => setCreating(null)}
            />
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

interface SpeakerMenuProps {
  icon: ReactNode
  label: string
  /** The menu's heading, kiChat's "Zuweisen an:". */
  heading: string
  /** Stored speaker names. */
  options: readonly string[]
  onPick: (speaker: string) => void
  onNew: () => void
}

/** A menu of the other speakers and "New speaker". */
function SpeakerMenu({
  icon,
  label,
  heading,
  options,
  onPick,
  onNew
}: SpeakerMenuProps): React.JSX.Element {
  const { t } = useTranslation()
  const speakerLabel = useSpeakerLabel()
  // The name panel opens as the menu closes; the menu must not take the focus back then.
  const newRequested = useRef(false)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label={label}>{icon}</IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        onCloseAutoFocus={(event) => {
          if (!newRequested.current) return
          newRequested.current = false
          event.preventDefault()
        }}
      >
        <DropdownMenuLabel>{heading}</DropdownMenuLabel>
        {options.map((speaker) => (
          <DropdownMenuItem key={speaker} onSelect={() => onPick(speaker)}>
            {speakerLabel(speaker)}
          </DropdownMenuItem>
        ))}
        {options.length > 0 ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem
          onSelect={() => {
            newRequested.current = true
            onNew()
          }}
        >
          <PlusIcon aria-hidden="true" className="size-4" />
          {t('transcription.result.newSpeaker')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
