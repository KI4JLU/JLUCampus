import { useId, useState, type ReactNode } from 'react'
import {
  BookmarkIcon,
  BookOpenIcon,
  BracesIcon,
  CaptionsIcon,
  ClockIcon,
  FileTextIcon,
  ListChecksIcon,
  MessagesSquareIcon,
  SaveIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
  UsersIcon
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Badge,
  Button,
  Input,
  Label,
  NavItem,
  PanelSection,
  SegmentedControl,
  Spinner,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '@ki4jlu/design-system'
import {
  TRANSCRIPT_PRESET_IDS,
  TRANSCRIPTION_FORMAT_NAME_MAX,
  type TranscriptFormatFlags,
  type TranscriptionFormat,
  type TranscriptOrder,
  type TranscriptPresetId
} from '@justcampus/shared'
import { ApiRequestError } from '@/lib/api'
import { toast } from '@/lib/toast'
import { useDeleteFormat, useSaveFormat, useTranscriptionFormats } from '../api'
import { useTranscriptionWorkspace } from '../use-workspace'
import type { ExportCategory } from './files'
import { isSpeakerVisible, speakerColorId, speakerLabel, speakersInOrder } from './format'
import { TRANSCRIPT_FORMATTING_ID } from './formatting-focus'
import { useSpeakerLabels } from './hooks'
import { SpeakerAvatar } from './parts'
import { formatDetails, isChoice, uniqueFormatName } from './presets'
import { exportActions, useExportState } from './store'

const ICON = { 'aria-hidden': true, className: 'size-4' } as const

const PRESET_ICONS: Record<TranscriptPresetId, ReactNode> = {
  dialog_standard: <SlidersHorizontalIcon {...ICON} />,
  lesefassung: <BookOpenIcon {...ICON} />,
  zeitcodes: <ClockIcon {...ICON} />,
  sprecher_gruppiert: <UsersIcon {...ICON} />,
  fliesstext: <FileTextIcon {...ICON} />
}

/** The export's settings in the side column: what to export, and how the transcript looks. */
export function ExportSettings(): React.JSX.Element {
  const { category } = useExportState()
  return (
    <div className="flex flex-col gap-stack-lg">
      <CategoryChoice />
      {category === 'transcript' ? <TranscriptFormatting /> : null}
      {category === 'subtitles' ? <SubtitleSettings /> : null}
    </div>
  )
}

interface CategoryOption {
  value: ExportCategory
  icon: ReactNode
  title: string
  description: string
}

/** kiChat's export cards in their groups: documents, video, data (T-41). */
function CategoryChoice(): React.JSX.Element {
  const { t } = useTranslation()
  const { category } = useExportState()
  const id = useId()
  const groups: { label: string; options: CategoryOption[] }[] = [
    {
      label: t('transcription.export.categoryDocuments'),
      options: [
        {
          value: 'summary',
          icon: <ListChecksIcon {...ICON} />,
          title: t('transcription.export.summary'),
          description: t('transcription.export.summaryDesc')
        },
        {
          value: 'transcript',
          icon: <MessagesSquareIcon {...ICON} />,
          title: t('transcription.export.fullTranscript'),
          description: t('transcription.export.fullTranscriptDesc')
        }
      ]
    },
    {
      label: t('transcription.export.categoryVideo'),
      options: [
        {
          value: 'subtitles',
          icon: <CaptionsIcon {...ICON} />,
          title: t('transcription.export.subtitles'),
          description: t('transcription.export.subtitlesDesc')
        }
      ]
    },
    {
      label: t('transcription.export.categoryData'),
      options: [
        {
          value: 'json',
          icon: <BracesIcon {...ICON} />,
          title: t('transcription.export.rawData'),
          description: t('transcription.export.rawDataDesc')
        }
      ]
    }
  ]

  return (
    <PanelSection title={t('transcription.export.question')}>
      <div className="flex flex-col gap-stack-md">
        {groups.map((group, index) => (
          <div
            key={group.label}
            role="group"
            aria-labelledby={`${id}-${index}`}
            className="flex flex-col gap-1"
          >
            {/* DS gap: no heading for a group of choices; `Label` gives it the label's look. */}
            <Label id={`${id}-${index}`}>{group.label}</Label>
            <ul className="m-0 grid list-none grid-cols-1 gap-1 p-0">
              {group.options.map((option) => {
                const active = category === option.value
                return (
                  <li key={option.value}>
                    <NavItem
                      type="button"
                      level="sub"
                      active={active}
                      aria-current={active ? 'true' : undefined}
                      onClick={() => exportActions.setCategory(option.value)}
                    >
                      {option.icon}
                      <OptionText title={option.title} description={option.description} />
                    </NavItem>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </div>
    </PanelSection>
  )
}

/**
 * A choice's name with its description below.
 * DS gap: NavItem has no second, muted line; the description takes the row's text style.
 */
function OptionText({
  title,
  description
}: {
  title: string
  description: string
}): React.JSX.Element {
  return (
    <span className="flex min-w-0 flex-1 flex-col items-start">
      <span className="max-w-full truncate">{title}</span>
      <span className="max-w-full truncate">{description}</span>
    </span>
  )
}

/** A switch with its label, as the translator's settings show them. */
function ToggleRow({
  label,
  checked,
  onChange
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  const id = useId()
  return (
    <div className="flex min-h-10 flex-row-reverse items-center justify-between gap-3 px-3">
      <Switch id={id} checked={checked} onCheckedChange={onChange} className="peer" />
      <Label htmlFor={id} className="flex min-w-0 items-center gap-3">
        <span className="truncate">{label}</span>
      </Label>
    </div>
  )
}

/** Subtitles name speakers as the transcript format does; its anonymising applies (T-46). */
function SubtitleSettings(): React.JSX.Element {
  const { t } = useTranslation()
  const { flags } = useExportState()
  return (
    <PanelSection title={t('transcription.export.formatting')}>
      <ToggleRow
        label={t('transcription.export.toggleAnonymize')}
        checked={flags.anonymize}
        onChange={(value) => exportActions.setFlag('anonymize', value)}
      />
    </PanelSection>
  )
}

/** The presets' names in the current language. */
function usePresetNames(): Record<TranscriptPresetId, string> {
  const { t } = useTranslation()
  return {
    dialog_standard: t('transcription.export.presetDialog'),
    lesefassung: t('transcription.export.presetReading'),
    zeitcodes: t('transcription.export.presetTimecodes'),
    sprecher_gruppiert: t('transcription.export.presetBySpeaker'),
    fliesstext: t('transcription.export.presetPlainText')
  }
}

/**
 * The format in use with its icon, as the preview's subheader names it: a preset, a saved
 * format (bookmark) or "Benutzerdefiniert" (sliders), as kiChat.
 */
export function ActiveFormatName(): React.JSX.Element {
  const { t } = useTranslation()
  const { choice } = useExportState()
  const formats = useTranscriptionFormats()
  const presetName = usePresetNames()
  const saved =
    choice.kind === 'saved' ? formats.data?.find((format) => format.id === choice.id) : undefined
  const [icon, name] =
    choice.kind === 'preset'
      ? [PRESET_ICONS[choice.id], presetName[choice.id]]
      : saved
        ? [<BookmarkIcon key="saved" {...ICON} />, saved.name]
        : [<SlidersHorizontalIcon key="custom" {...ICON} />, t('transcription.export.custom')]
  return (
    <span className="flex min-w-0 items-center gap-stack-sm">
      {icon}
      <span className="truncate">{name}</span>
    </span>
  )
}

/**
 * The transcript's format (T-43 to T-45): kiChat's presets and the user's saved formats, the
 * switches, the order, which speakers show, and saving the settings as a format of one's own.
 */
function TranscriptFormatting(): React.JSX.Element {
  const { t } = useTranslation()
  const { flags, choice } = useExportState()
  const formats = useTranscriptionFormats()
  const presetName = usePresetNames()
  const presetDescription: Record<TranscriptPresetId, string> = {
    dialog_standard: t('transcription.export.presetDialogDesc'),
    lesefassung: t('transcription.export.presetReadingDesc'),
    zeitcodes: t('transcription.export.presetTimecodesDesc'),
    sprecher_gruppiert: t('transcription.export.presetBySpeakerDesc'),
    fliesstext: t('transcription.export.presetPlainTextDesc')
  }
  const toggles: { key: Exclude<keyof TranscriptFormatFlags, 'order'>; label: string }[] = [
    { key: 'speakers', label: t('transcription.export.toggleSpeakerNames') },
    { key: 'timestamps', label: t('transcription.export.toggleTimestamps') },
    { key: 'anonymize', label: t('transcription.export.toggleAnonymize') },
    { key: 'avatars', label: t('transcription.export.toggleAvatars') },
    { key: 'bubbles', label: t('transcription.export.toggleBubbles') }
  ]

  // kiChat's order: own formats, presets, the switches, the order, the speakers, saving.
  return (
    <div id={TRANSCRIPT_FORMATTING_ID} className="flex flex-col gap-stack-lg">
      <SavedFormats formats={formats.data} failed={formats.isError} loading={formats.isPending} />

      <PanelSection
        title={t('transcription.export.presets')}
        aside={
          choice.kind === 'custom' ? (
            <Badge tone="neutral">{t('transcription.export.custom')}</Badge>
          ) : undefined
        }
      >
        <ul className="m-0 grid list-none grid-cols-1 gap-1 p-0">
          {TRANSCRIPT_PRESET_IDS.map((id) => {
            const active = isChoice(choice, { kind: 'preset', id })
            return (
              <li key={id}>
                <NavItem
                  type="button"
                  level="sub"
                  active={active}
                  aria-current={active ? 'true' : undefined}
                  onClick={() => exportActions.choosePreset(id)}
                >
                  {PRESET_ICONS[id]}
                  <OptionText title={presetName[id]} description={presetDescription[id]} />
                  {active ? <ActiveBadge /> : null}
                </NavItem>
              </li>
            )
          })}
        </ul>
      </PanelSection>

      <PanelSection title={t('transcription.export.customise')}>
        {toggles.map((toggle) => (
          <ToggleRow
            key={toggle.key}
            label={toggle.label}
            checked={flags[toggle.key]}
            onChange={(value) => exportActions.setFlag(toggle.key, value)}
          />
        ))}
      </PanelSection>

      <PanelSection title={t('transcription.export.order')}>
        <SegmentedControl
          aria-label={t('transcription.export.order')}
          value={flags.order}
          onValueChange={(value) => exportActions.setFlag('order', value as TranscriptOrder)}
          options={[
            { value: 'chronological', label: t('transcription.export.orderChronological') },
            { value: 'speaker', label: t('transcription.export.orderBySpeaker') }
          ]}
        />
      </PanelSection>

      <SpeakerChips />

      <SaveFormat formats={formats.data ?? []} />
    </div>
  )
}

function ActiveBadge(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Badge tone="primary" className="ml-auto shrink-0">
      {t('transcription.export.active')}
    </Badge>
  )
}

/** The user's saved formats with their settings in a line; each can be used or deleted (T-45). */
function SavedFormats({
  formats,
  failed,
  loading
}: {
  formats: TranscriptionFormat[] | undefined
  failed: boolean
  loading: boolean
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const { choice } = useExportState()
  const remove = useDeleteFormat()
  const details = {
    names: t('transcription.export.names'),
    timestamps: t('transcription.export.toggleTimestamps'),
    avatars: t('transcription.export.toggleAvatars'),
    bubbles: t('transcription.export.bubbles'),
    anonymised: t('transcription.export.anonymised'),
    chronological: t('transcription.export.chronological'),
    bySpeaker: t('transcription.export.bySpeakerShort')
  }

  const deleteFormat = (format: TranscriptionFormat): void => {
    remove.mutate(format.id, {
      onSuccess: () => exportActions.formatDeleted(format.id),
      onError: (error) =>
        toast({
          variant: 'error',
          title:
            error instanceof ApiRequestError
              ? t('transcription.export.templateDeleteFailed') +
                (error.body?.error.message ?? t('transcription.common.unknownError'))
              : t('transcription.export.formatDeleteConnectionError')
        })
    })
  }

  if (loading) return <Spinner label={t('transcription.common.loading')} />
  if (failed) return <p className="m-0">{t('transcription.export.formatsLoadFailed')}</p>
  if (!formats || formats.length === 0) return null
  return (
    <PanelSection title={t('transcription.export.myTemplates')}>
      <ul className="m-0 grid list-none grid-cols-1 gap-1 p-0">
        {formats.map((format) => {
          const active = isChoice(choice, { kind: 'saved', id: format.id })
          const label = t('transcription.export.deleteFormat', { name: format.name })
          return (
            <li key={format.id} className="flex items-center gap-1">
              <NavItem
                type="button"
                level="sub"
                active={active}
                aria-current={active ? 'true' : undefined}
                onClick={() => exportActions.chooseFormat(format)}
                className="min-w-0 flex-1"
              >
                <BookmarkIcon {...ICON} />
                <OptionText title={format.name} description={formatDetails(format, details)} />
                {active ? <ActiveBadge /> : null}
              </NavItem>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost-destructive"
                    size="icon"
                    aria-label={label}
                    disabled={remove.isPending && remove.variables === format.id}
                    onClick={() => deleteFormat(format)}
                  >
                    <Trash2Icon {...ICON} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{label}</TooltipContent>
              </Tooltip>
            </li>
          )
        })}
      </ul>
    </PanelSection>
  )
}

/**
 * One chip per speaker of the open transcript; a pressed chip shows the speaker in the transcript
 * export, an unpressed one leaves them out (T-43). Not saved with a format.
 */
function SpeakerChips(): React.JSX.Element {
  const { t } = useTranslation()
  const { currentDocument } = useTranscriptionWorkspace()
  const { visibleSpeakers } = useExportState()
  const labels = useSpeakerLabels()
  const transcriptId = currentDocument?.transcript.id ?? ''
  const visible = visibleSpeakers[transcriptId] ?? {}
  const segments = currentDocument?.segments ?? []
  const speakers = speakersInOrder(segments, labels.unknown)

  return (
    <PanelSection title={t('transcription.export.showSpeakers')}>
      {speakers.length === 0 ? (
        <p className="m-0">{t('transcription.export.noSpeakers')}</p>
      ) : (
        <div
          role="group"
          aria-label={t('transcription.export.showSpeakers')}
          className="flex flex-wrap gap-stack-sm"
        >
          {speakers.map((key) => {
            const segment = segments.find((item) => (item.speaker ?? labels.unknown) === key)
            const name = speakerLabel(segment?.speaker ?? null, labels)
            return (
              <Button
                key={key}
                type="button"
                variant="outline"
                size="sm"
                aria-pressed={isSpeakerVisible(visible, key)}
                onClick={() => exportActions.toggleSpeaker(transcriptId, key)}
              >
                <SpeakerAvatar
                  name={name}
                  colorId={speakerColorId(key, currentDocument?.speakerColors ?? {}, speakers)}
                  size="xs"
                />
                {name}
              </Button>
            )
          })}
        </div>
      )}
    </PanelSection>
  )
}

/**
 * Saves the current settings as a format (T-45): a new one, or the saved one in use under its
 * (new) name. A blank name is refused; a name another format has gets a number.
 */
function SaveFormat({ formats }: { formats: TranscriptionFormat[] }): React.JSX.Element {
  const { t } = useTranslation()
  const { flags, editingFormatId, formatChoices } = useExportState()
  const editing = formats.find((format) => format.id === editingFormatId)
  // A new name field for every format chosen: prefilled with a saved one's name, empty for presets.
  return (
    <SaveFormatForm
      key={`${formatChoices}-${editing?.id ?? ''}`}
      initialName={editing?.name ?? ''}
      flags={flags}
      editingId={editing?.id ?? null}
      formats={formats}
      label={t('transcription.export.saveTemplate')}
    />
  )
}

function SaveFormatForm({
  initialName,
  flags,
  editingId,
  formats,
  label
}: {
  initialName: string
  flags: TranscriptFormatFlags
  editingId: string | null
  formats: TranscriptionFormat[]
  label: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const id = useId()
  const [name, setName] = useState(initialName)
  const [invalid, setInvalid] = useState(false)
  const save = useSaveFormat()

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    const finalName = uniqueFormatName(name, formats, editingId)
    if (!finalName) {
      setInvalid(true)
      toast({
        variant: 'error',
        title: t('transcription.export.nameRequiredTitle'),
        description: t('transcription.export.nameRequired')
      })
      return
    }
    save.mutate(
      { id: editingId, name: finalName, ...flags },
      {
        onSuccess: (format) => exportActions.chooseFormat(format),
        onError: (error) =>
          toast({
            variant: 'error',
            title:
              error instanceof ApiRequestError
                ? t('transcription.export.templateSaveFailed') +
                  (error.body?.error.message ?? t('transcription.common.unknownError'))
                : t('transcription.export.formatSaveConnectionError')
          })
      }
    )
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-stack-sm">
      <Label htmlFor={id}>{t('transcription.export.saveAsOwnTemplate')}</Label>
      <Input
        id={id}
        value={name}
        maxLength={TRANSCRIPTION_FORMAT_NAME_MAX}
        placeholder={t('transcription.export.templateNameInputPlaceholder')}
        aria-invalid={invalid || undefined}
        onChange={(event) => {
          setName(event.target.value)
          setInvalid(false)
        }}
      />
      <Button type="submit" variant="outline" disabled={save.isPending}>
        {save.isPending ? <Spinner size="sm" label={label} /> : <SaveIcon {...ICON} />}
        {label}
      </Button>
    </form>
  )
}
