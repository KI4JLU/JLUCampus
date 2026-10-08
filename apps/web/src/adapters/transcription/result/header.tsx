import { useEffect, useRef, useState } from 'react'
import { CheckIcon, PencilIcon, RotateCcwIcon, SaveIcon, SparklesIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button, Input, PageHeader, SegmentedControl, Spinner } from '@ki4jlu/design-system'
import { TRANSCRIPTION_SUBTITLE_MAX, TRANSCRIPTION_TITLE_MAX } from '@justcampus/shared'
import { toast } from '@/lib/toast'
import type { ResultTab } from '../workspace'
import { IconButton } from './icon-button'
import type { ResultSession, ResultState } from './session'

interface ResultHeaderProps {
  session: ResultSession
  state: ResultState
  tab: ResultTab
  onTab: (tab: ResultTab) => void
  /** Whether the module's chat model can write a subtitle. */
  canGenerateSubtitle: boolean
}

/**
 * The head of a saved transcript (T-22, T-23, T-35): its title and subtitle, both edited in place
 * (Enter or leaving the field saves, Escape cancels), the save control (kiChat's only header action)
 * and the switch between Corrections, Preview and Export.
 */
export function ResultHeader({
  session,
  state,
  tab,
  onTab,
  canGenerateSubtitle
}: ResultHeaderProps): React.JSX.Element {
  const { t } = useTranslation()
  const { transcript } = state

  const saveTitle = async (value: string): Promise<void> => {
    if (!(await session.setTitle(value))) {
      toast({ variant: 'error', title: t('transcription.result.titleSaveFailed') })
    }
  }
  const saveSubtitle = async (value: string): Promise<void> => {
    if (!(await session.setSubtitle(value))) {
      toast({ variant: 'error', title: t('transcription.result.subtitleSaveFailed') })
    }
  }
  const generateSubtitle = async (): Promise<void> => {
    if (!(await session.generateSubtitle())) {
      toast({ variant: 'error', title: t('transcription.result.generateSubtitleFailed') })
    }
  }

  const subtitleBusy = state.awaitingSubtitle || state.generatingSubtitle

  return (
    <PageHeader
      headingLevel={2}
      title={
        <InlineEdit
          value={transcript.title}
          label={t('transcription.result.titleLabel')}
          hint={t('transcription.result.editTitleHint')}
          maxLength={TRANSCRIPTION_TITLE_MAX}
          allowEmpty={false}
          onCommit={(value) => void saveTitle(value)}
        />
      }
      description={
        <span className="flex flex-wrap items-center gap-2">
          <InlineEdit
            value={transcript.subtitle ?? ''}
            placeholder={t('transcription.result.subtitlePlaceholder')}
            label={t('transcription.result.subtitleLabel')}
            hint={t('transcription.result.editSubtitleHint')}
            maxLength={TRANSCRIPTION_SUBTITLE_MAX}
            allowEmpty
            onEditing={(editing) => session.setEditingSubtitle(editing)}
            onCommit={(value) => void saveSubtitle(value)}
          />
          {subtitleBusy ? (
            <Spinner size="sm" label={t('transcription.result.generatingSubtitle')} />
          ) : canGenerateSubtitle && !state.local ? (
            <IconButton
              label={t('transcription.result.generateSubtitle')}
              onClick={() => void generateSubtitle()}
            >
              <SparklesIcon aria-hidden="true" className="size-4" />
            </IconButton>
          ) : null}
        </span>
      }
      actions={<SaveControl session={session} state={state} />}
    >
      <SegmentedControl
        aria-label={t('transcription.common.views.label')}
        value={tab}
        onValueChange={(value) => onTab(value as ResultTab)}
        options={[
          { value: 'corrections', label: t('transcription.common.tabCorrections') },
          { value: 'preview', label: t('transcription.common.tabPreview') },
          { value: 'export', label: t('transcription.common.tabExport') }
        ]}
        className="self-center"
      />
    </PageHeader>
  )
}

interface InlineEditProps {
  value: string
  label: string
  /** kiChat's "Klicken, um … zu bearbeiten". */
  hint: string
  placeholder?: string
  maxLength: number
  /** Whether an empty value is saved (the subtitle) or keeps the old one (the title). */
  allowEmpty: boolean
  onCommit: (value: string) => void
  onEditing?: (editing: boolean) => void
}

/**
 * Text that becomes a field on click, after kiChat's `editWorkspaceTranscriptTitle`: Enter or
 * leaving the field commits a changed value, Escape restores the old one, the caret starts at
 * the end.
 */
function InlineEdit({
  value,
  label,
  hint,
  placeholder,
  maxLength,
  allowEmpty,
  onCommit,
  onEditing
}: InlineEditProps): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const finished = useRef(false)

  useEffect(() => {
    if (!editing) return
    const input = field.current
    if (!input) return
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
  }, [editing])

  const start = (): void => {
    finished.current = false
    onEditing?.(true)
    setEditing(true)
  }

  const finish = (commit: boolean): void => {
    if (finished.current) return
    finished.current = true
    const next = field.current?.value.trim() ?? ''
    setEditing(false)
    onEditing?.(false)
    if (!commit || next === value.trim() || (!next && !allowEmpty)) return
    onCommit(next)
  }

  if (editing) {
    return (
      <Input
        ref={field}
        defaultValue={value}
        aria-label={label}
        placeholder={placeholder}
        maxLength={maxLength}
        className="w-full"
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            finish(true)
          } else if (event.key === 'Escape') {
            event.preventDefault()
            finish(false)
          }
        }}
        onBlur={() => finish(true)}
      />
    )
  }

  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1">
      <span className="min-w-0 break-words" title={hint} onClick={start}>
        {value || placeholder}
      </span>
      <IconButton label={hint} onClick={start}>
        <PencilIcon aria-hidden="true" className="size-4" />
      </IconButton>
    </span>
  )
}

/**
 * The save state of the edits (T-35), after kiChat's save button: "Datei speichern" until the
 * first save, "Speichern..." while a save runs (pressing it waits for it), "Gespeichert" for two
 * seconds after a save or a press, then "Änderungen speichern"; a failed save stays visible with
 * a retry. Screen readers hear the changes.
 */
function SaveControl({
  session,
  state
}: {
  session: ResultSession
  state: ResultState
}): React.JSX.Element {
  const { t } = useTranslation()
  const status = state.saveStatus
  const announcement =
    status === 'pending'
      ? t('transcription.common.saving')
      : status === 'failed'
        ? t('transcription.result.saveFailed')
        : status === 'conflict'
          ? t('transcription.result.saveConflict')
          : state.savedCount > 0
            ? t('transcription.common.saved')
            : ''

  let control: React.JSX.Element
  if (status === 'pending') {
    control = (
      <Button type="button" variant="outline" onClick={() => void session.save()}>
        <Spinner size="sm" label={t('transcription.common.saving')} />
        {t('transcription.common.saving')}
      </Button>
    )
  } else if (status === 'failed') {
    control = (
      <Button type="button" variant="destructive-outline" onClick={() => session.retry()}>
        <RotateCcwIcon aria-hidden="true" className="size-4" />
        {t('transcription.common.retry')}
      </Button>
    )
  } else if (status === 'conflict') {
    control = (
      <Button type="button" variant="destructive-outline" disabled>
        {t('transcription.common.error')}
      </Button>
    )
  } else {
    control = <SavedButton key={state.savedCount} saved={state.savedCount > 0} session={session} />
  }

  return (
    <>
      {control}
      <span aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </>
  )
}

/**
 * "Datei speichern" before the first save of the session, else "Gespeichert" for two seconds
 * after a save, then "Änderungen speichern".
 */
function SavedButton({
  saved,
  session
}: {
  saved: boolean
  session: ResultSession
}): React.JSX.Element {
  const { t } = useTranslation()
  const [fresh, setFresh] = useState(saved)
  useEffect(() => {
    if (!saved) return
    const timer = setTimeout(() => setFresh(false), 2000)
    return () => clearTimeout(timer)
  }, [saved])
  return (
    <Button type="button" variant="outline" onClick={() => void session.save()}>
      {fresh ? (
        <CheckIcon aria-hidden="true" className="size-4" />
      ) : (
        <SaveIcon aria-hidden="true" className="size-4" />
      )}
      {fresh
        ? t('transcription.common.saved')
        : saved
          ? t('transcription.result.saveChanges')
          : t('transcription.common.saveFile')}
    </Button>
  )
}
