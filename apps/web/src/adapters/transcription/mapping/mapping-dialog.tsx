import { useEffect, useId, useRef, useState } from 'react'
import {
  CheckIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  TriangleAlertIcon,
  Volume2Icon,
  XIcon
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Spinner
} from '@ki4jlu/design-system'
import { TRANSCRIPTION_SPEAKER_NAME_MAX } from '@justcampus/shared'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { useJobAudioUrl } from '../api'
import { findFile, type QueueFile } from '../upload/queue'
import { useQueueState, useUpload } from '../upload/use-upload'
import { ColorPicker } from './color-picker'
import { useSamplePlayer, useSampleSource, type SamplePlayer } from './sample-audio'
import { SampleEditor } from './sample-editor'
import {
  canAddSample,
  isAutoLabel,
  localizeAutoLabel,
  localizeSampleLabel,
  manualVoice,
  newSampleWindow,
  nextSampleNumber,
  orderVoices,
  voiceColor,
  type SampleDraft,
  type VoiceDraft
} from './speakers'
import { useTimePeaks, type TimePeaks } from './window-peaks'

const ICON = { 'aria-hidden': true, className: 'size-4' } as const

/** kiChat shows "Gespeichert!" this long before the dialog closes. */
const SAVED_MS = 600

export interface SpeakerMappingDialogProps {
  /** The queue row whose voices are named; `null` keeps the dialog closed. */
  fileId: string | null
  onOpenChange: (open: boolean) => void
}

/**
 * kiChat's `openSpeakerMappingModal` (T-17 to T-21): the analysed voices in the order they first
 * speak, each with its name, colour and samples; samples play, open for editing, can be added and
 * deleted; voices can be added and removed; the analysis can run again. The dialog edits a copy:
 * only Save keeps it, for the dispatch to send (there is no separate save on the server).
 */
export function SpeakerMappingDialog({
  fileId,
  onOpenChange
}: SpeakerMappingDialogProps): React.JSX.Element {
  const state = useQueueState()
  const file = fileId ? (findFile(state.groups, fileId)?.file ?? null) : null
  return (
    <Dialog open={file !== null} onOpenChange={onOpenChange}>
      {file ? (
        <MappingContent key={file.id} file={file} onClose={() => onOpenChange(false)} />
      ) : null}
    </Dialog>
  )
}

/** Which sample's detail is open. */
interface Editing {
  voiceId: string
  key: string
}

function MappingContent({
  file,
  onClose
}: {
  file: QueueFile
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { queue, dialogs } = useUpload()
  const autoLabel = (n: number): string => t('transcription.common.speakerN', { n })
  const sampleLabel = (n: number): string => t('transcription.upload.sampleN', { n })

  /** The saved voices, in order, automatic names and sample labels in the UI language (T-02). */
  const prepare = (voices: readonly VoiceDraft[] | null): VoiceDraft[] =>
    orderVoices(voices ?? []).map((voice, index) => ({
      ...voice,
      name: isAutoLabel(voice.name) ? localizeAutoLabel(voice.name, index, autoLabel) : voice.name,
      samples: voice.samples.map((sample) => ({
        ...sample,
        label: localizeSampleLabel(sample.label, sampleLabel)
      }))
    }))

  const [base, setBase] = useState(file.voices)
  const [draft, setDraft] = useState(() => prepare(file.voices))
  const [editing, setEditing] = useState<Editing | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [added, setAdded] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [reanalyzing, setReanalyzing] = useState(() => queue.isReanalyzing(file.id))
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => clearTimeout(closeTimer.current ?? undefined), [])

  // A new analysis replaces the voices: the copy starts over from them (T-21).
  if (base !== file.voices) {
    setBase(file.voices)
    setDraft(prepare(file.voices))
    setEditing(null)
    setRemoving(null)
  }

  const source = useSampleSource(file)
  const player = useSamplePlayer(source.resolve)
  const remote = useJobAudioUrl(file.file ? null : file.jobId)
  const peaks = useTimePeaks(
    file.file
      ? { blob: file.file }
      : file.jobId
        ? { jobId: file.jobId, url: remote.data?.url ?? null }
        : null
  )
  const duration = file.duration ?? peaks?.duration ?? player.duration

  const updateVoice = (
    voiceId: string,
    change: Partial<VoiceDraft> | ((voice: VoiceDraft) => Partial<VoiceDraft>)
  ): void =>
    setDraft((voices) =>
      voices.map((voice) =>
        voice.id === voiceId
          ? { ...voice, ...(typeof change === 'function' ? change(voice) : change) }
          : voice
      )
    )

  const updateSample = (voiceId: string, key: string, change: Partial<SampleDraft>): void =>
    updateVoice(voiceId, (voice) => ({
      samples: voice.samples.map((sample) =>
        sample.key === key ? { ...sample, ...change } : sample
      )
    }))

  const addSample = (voice: VoiceDraft): void => {
    const window = newSampleWindow(voice.samples, duration)
    if (!window || !canAddSample(voice)) return
    const sample: SampleDraft = {
      key: `local-${crypto.randomUUID()}`,
      label: t('transcription.upload.sampleN', { n: nextSampleNumber(voice.samples) }),
      ...window
    }
    updateVoice(voice.id, { samples: [...voice.samples, sample] })
    player.stop()
    // kiChat opens the new sample's detail at once.
    setEditing({ voiceId: voice.id, key: sample.key })
  }

  const deleteSample = (voiceId: string, key: string): void => {
    player.stop()
    setEditing(null)
    updateVoice(voiceId, (voice) => ({
      samples: voice.samples.filter((sample) => sample.key !== key)
    }))
  }

  const removeVoice = (voiceId: string): void => {
    player.stop()
    if (editing?.voiceId === voiceId) setEditing(null)
    setRemoving(null)
    setDraft((voices) => voices.filter((voice) => voice.id !== voiceId))
  }

  const addVoice = (): void => {
    const voice = manualVoice(draft, autoLabel)
    setDraft((voices) => [...voices, voice])
    setAdded(voice.id)
  }

  const reanalyze = async (): Promise<void> => {
    player.stop()
    setEditing(null)
    setReanalyzing(true)
    const outcome = await queue.reanalyze(file.id, { keepVoices: false })
    setReanalyzing(false)
    if (!outcome.ok) {
      await dialogs.alert({
        title: t('transcription.common.error'),
        message: `${t('transcription.upload.speakerAnalysisRetryFailed')}${
          outcome.message ?? t('transcription.common.unknown')
        }`
      })
    }
  }

  const save = (): void => {
    player.stop()
    queue.saveVoices(file.id, draft)
    setSaved(true)
    closeTimer.current = setTimeout(onClose, SAVED_MS)
  }

  return (
    <DialogContent
      closeLabel={t('transcription.common.close')}
      // DS gap: DialogContent has no height cap of its own; the voices scroll in it. One shrinkable
      // column keeps long names inside.
      className="max-h-9/10 grid-cols-1 overflow-y-auto sm:max-w-2xl"
      onEscapeKeyDown={() => player.stop()}
    >
      <DialogHeader>
        {/* The right padding keeps the action clear of the dialog's own close button. */}
        <div className="flex flex-wrap items-start justify-between gap-stack-sm pr-8">
          <div className="flex min-w-0 flex-col gap-1">
            <DialogTitle>{t('transcription.upload.adjustSpeakers')}</DialogTitle>
            <DialogDescription>{file.name}</DialogDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={reanalyzing || !file.uploaded || !file.jobId}
            title={t('transcription.upload.rerunSpeakerAnalysis')}
            onClick={() => void reanalyze()}
          >
            {reanalyzing ? (
              <Spinner size="sm" label={t('transcription.upload.analyzingSpeakers')} />
            ) : (
              <RefreshCwIcon {...ICON} />
            )}
            {reanalyzing
              ? t('transcription.upload.analyzingSpeakers')
              : t('transcription.upload.repeatAnalysis')}
          </Button>
        </div>
      </DialogHeader>

      {player.failed ? (
        <Alert variant="destructive">
          <TriangleAlertIcon aria-hidden="true" />
          <AlertDescription>{t('transcription.upload.mapping.audioUnavailable')}</AlertDescription>
        </Alert>
      ) : null}

      <div aria-busy={reanalyzing || undefined} className="flex flex-col gap-stack-md">
        {draft.length === 0 ? (
          <Badge appearance="text">{t('transcription.upload.mapping.noVoices')}</Badge>
        ) : null}
        {draft.map((voice, index) => (
          <VoiceCard
            key={voice.id}
            voice={voice}
            index={index}
            duration={duration}
            peaks={peaks}
            player={player}
            editing={editing?.voiceId === voice.id ? editing.key : null}
            removing={removing === voice.id}
            focusName={added === voice.id}
            disabled={reanalyzing}
            onName={(name) => updateVoice(voice.id, { name })}
            onColor={(colorId) => updateVoice(voice.id, { colorId })}
            onRemove={() => setRemoving(voice.id)}
            onCancelRemove={() => setRemoving(null)}
            onConfirmRemove={() => removeVoice(voice.id)}
            onSample={(sample) => {
              // A chip plays its sample; another sample's open detail closes (kiChat).
              if (editing?.key !== sample.key) setEditing(null)
              player.toggle(sample.key, sample.start, sample.end)
            }}
            onEdit={(sample) => {
              player.stop()
              setEditing(
                editing?.key === sample.key ? null : { voiceId: voice.id, key: sample.key }
              )
            }}
            onAddSample={() => addSample(voice)}
            onChangeSample={(key, change) => updateSample(voice.id, key, change)}
            onDeleteSample={(key) => deleteSample(voice.id, key)}
          />
        ))}
        <Button type="button" variant="outline" disabled={reanalyzing} onClick={addVoice}>
          <PlusIcon {...ICON} />
          {t('transcription.upload.addSpeaker')}
        </Button>
      </div>

      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="secondary">
            {t('transcription.common.close')}
          </Button>
        </DialogClose>
        <Button type="button" disabled={reanalyzing || saved} onClick={save}>
          {saved ? <CheckIcon {...ICON} /> : null}
          {saved ? t('transcription.common.savedExclaim') : t('transcription.common.save')}
        </Button>
      </DialogFooter>
      {/* The samples' sound: windows of the one file, from where they start to where they end. */}
      {player.element}
    </DialogContent>
  )
}

interface VoiceCardProps {
  voice: VoiceDraft
  index: number
  duration: number | null
  peaks: TimePeaks | null
  player: SamplePlayer
  /** The key of the sample whose detail is open. */
  editing: string | null
  removing: boolean
  focusName: boolean
  disabled: boolean
  onName: (name: string) => void
  onColor: (colorId: NonNullable<VoiceDraft['colorId']>) => void
  onRemove: () => void
  onCancelRemove: () => void
  onConfirmRemove: () => void
  onSample: (sample: SampleDraft) => void
  onEdit: (sample: SampleDraft) => void
  onAddSample: () => void
  onChangeSample: (key: string, change: Partial<SampleDraft>) => void
  onDeleteSample: (key: string) => void
}

/** One voice (kiChat's `speaker-mapping-card`): colour, name, removal, samples, sample detail. */
function VoiceCard(props: VoiceCardProps): React.JSX.Element {
  const { voice, index, player, editing } = props
  const { t } = useTranslation()
  const id = useId()
  const placeLabel = t('transcription.common.speakerN', { n: index + 1 })
  const voiceName = voice.name.trim() || placeLabel
  const editedSample = voice.samples.find((sample) => sample.key === editing) ?? null

  return (
    <Card>
      <CardContent className="flex flex-col gap-stack-md pt-6">
        <div className="flex items-end gap-3">
          <ColorPicker
            value={voiceColor(voice, index)}
            label={t('transcription.upload.mapping.colorOf', { voice: voiceName })}
            onChange={props.onColor}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <Label htmlFor={`${id}-name`}>{placeLabel}</Label>
            <Input
              id={`${id}-name`}
              value={voice.name}
              maxLength={TRANSCRIPTION_SPEAKER_NAME_MAX}
              placeholder={t('transcription.upload.enterNamePlaceholder')}
              // A voice just added takes the focus, to be named at once.
              autoFocus={props.focusName}
              disabled={props.disabled}
              onChange={(event) => props.onName(event.target.value)}
            />
          </div>
          <div className="flex shrink-0 gap-1">
            {props.removing ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t('transcription.upload.mapping.cancelRemoveVoice', {
                    voice: voiceName
                  })}
                  title={t('transcription.common.cancel')}
                  onClick={props.onCancelRemove}
                >
                  <XIcon {...ICON} />
                </Button>
                <Button
                  type="button"
                  variant="ghost-destructive"
                  size="icon"
                  aria-label={t('transcription.upload.mapping.confirmRemoveVoice', {
                    voice: voiceName
                  })}
                  title={t('transcription.common.confirm')}
                  autoFocus
                  onClick={props.onConfirmRemove}
                >
                  <CheckIcon {...ICON} />
                </Button>
              </>
            ) : (
              <Button
                type="button"
                variant="ghost-destructive"
                size="icon"
                disabled={props.disabled}
                aria-label={t('transcription.upload.mapping.removeVoiceOf', { voice: voiceName })}
                title={t('transcription.upload.removeSpeaker')}
                onClick={props.onRemove}
              >
                <Trash2Icon {...ICON} />
              </Button>
            )}
          </div>
        </div>

        <div
          role="group"
          aria-label={t('transcription.upload.mapping.samplesOf', { voice: voiceName })}
          className="flex flex-wrap items-center gap-2"
        >
          {voice.samples.map((sample) => {
            const playing = player.playing === sample.key
            return (
              <span key={sample.key} className="flex items-center">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-pressed={playing}
                  aria-label={
                    playing
                      ? t('transcription.upload.mapping.stopSample', { sample: sample.label })
                      : t('transcription.upload.mapping.playSample', { sample: sample.label })
                  }
                  disabled={props.disabled}
                  onClick={() => props.onSample(sample)}
                >
                  <Volume2Icon {...ICON} />
                  {sample.label}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-expanded={editing === sample.key}
                  aria-label={t('transcription.upload.mapping.editSample', {
                    sample: sample.label
                  })}
                  title={t('transcription.common.edit')}
                  disabled={props.disabled}
                  onClick={() => props.onEdit(sample)}
                >
                  <PencilIcon {...ICON} />
                </Button>
              </span>
            )
          })}
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={t('transcription.upload.mapping.addSampleTo', { voice: voiceName })}
            title={t('transcription.upload.addSnippet')}
            disabled={props.disabled || !canAddSample(voice)}
            onClick={props.onAddSample}
          >
            <PlusIcon {...ICON} />
          </Button>
        </div>

        {editedSample ? (
          <SampleEditor
            key={editedSample.key}
            sample={editedSample}
            voiceName={voiceName}
            duration={props.duration}
            peaks={props.peaks}
            playing={player.playing === editedSample.key}
            time={player.time}
            onPlay={(start, end) => void player.play(editedSample.key, start, end)}
            onStop={player.stop}
            onChange={(change) => props.onChangeSample(editedSample.key, change)}
            onDelete={() => props.onDeleteSample(editedSample.key)}
          />
        ) : null}
      </CardContent>
    </Card>
  )
}
