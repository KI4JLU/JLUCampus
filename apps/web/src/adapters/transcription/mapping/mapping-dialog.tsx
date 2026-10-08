import { useEffect, useId, useRef, useState } from 'react'
import {
  CheckIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
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
import {
  TRANSCRIPTION_SAMPLES_PER_SPEAKER_MAX,
  TRANSCRIPTION_SPEAKER_NAME_MAX
} from '@justcampus/shared'
import { useJobAudioUrl } from '../api'
import { decodesLocally } from '../audio'
import { Notice } from '../notice'
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
 * deleted; voices can be added and removed; the analysis can run again. As in kiChat, samples,
 * their windows, voices added or removed and colours change the file's voices at once and stay
 * when the dialog closes without Save; typed names stay a draft until Save, adding a voice or
 * picking a colour takes them (kiChat's `saveCurrentInputs`). Only Save marks the voices as
 * checked; the dispatch sends them (there is no separate save on the server).
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

/** Which sample's detail is open, by voice: one per voice, as kiChat's `toggleEditor`. */
type Editing = Record<string, string | null>

/** The repeated analysis: asked for (kiChat's `Analysiere...`), or answered as running. */
type Reanalysis = 'starting' | 'polling' | null

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

  /** The file's voices, in order, automatic names and sample labels in the UI language (T-02). */
  const voices = orderVoices(file.voices ?? []).map((voice, index) => ({
    ...voice,
    name: isAutoLabel(voice.name) ? localizeAutoLabel(voice.name, index, autoLabel) : voice.name,
    samples: voice.samples.map((sample) => ({
      ...sample,
      label: localizeSampleLabel(sample.label, sampleLabel)
    }))
  }))

  // Names typed but not taken yet, by voice; closing the dialog drops them, as kiChat does.
  const [names, setNames] = useState<Record<string, string>>({})
  const [editing, setEditing] = useState<Editing>({})
  const [removing, setRemoving] = useState<string | null>(null)
  const [added, setAdded] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [reanalysis, setReanalysis] = useState<Reanalysis>(() =>
    queue.isReanalyzing(file.id) ? 'polling' : null
  )
  const reanalyzing = reanalysis !== null
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => clearTimeout(closeTimer.current ?? undefined), [])

  const source = useSampleSource(file)
  const player = useSamplePlayer(source.resolve)
  const remote = useJobAudioUrl(file.file ? null : file.jobId)
  const loadedPeaks = useTimePeaks(
    file.file
      ? { blob: file.file, jobId: file.jobId, duration: file.duration }
      : file.jobId
        ? {
            jobId: file.jobId,
            url: remote.data?.url ?? null,
            size: file.size,
            type: file.mimeType,
            name: file.name,
            duration: file.duration
          }
        : null
  )
  const peaks = loadedPeaks ?? null
  const duration = file.duration ?? peaks?.duration ?? player.duration

  // kiChat's `speakerModalOutsideClickHandler`: a chip's preview stops at any click that is not
  // on a chip (a name, a colour, empty space, outside the dialog). A chip's own click plays its
  // sample, stops it or switches to another. What the sample editor plays goes on.
  const { preview, stop } = player
  useEffect(() => {
    const onClick = (event: MouseEvent): void => {
      if (preview() === null) return
      if (event.target instanceof Element && event.target.closest('[data-sample-key]')) return
      stop()
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [preview, stop])

  /** The voices with the names typed so far. */
  const withNames = (list: readonly VoiceDraft[]): VoiceDraft[] =>
    list.map((voice) => {
      const name = names[voice.id]
      return name === undefined ? voice : { ...voice, name }
    })

  const updateVoice = (
    voiceId: string,
    change: Partial<VoiceDraft> | ((voice: VoiceDraft) => Partial<VoiceDraft>)
  ): void =>
    queue.updateVoices(file.id, (list) =>
      list.map((voice) =>
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
    updateVoice(voice.id, (current) => ({ samples: [...current.samples, sample] }))
    player.stop()
    // kiChat opens the new sample's detail at once.
    setEditing((open) => ({ ...open, [voice.id]: sample.key }))
  }

  const deleteSample = (voiceId: string, key: string): void => {
    player.stop()
    setEditing((open) => ({ ...open, [voiceId]: null }))
    updateVoice(voiceId, (voice) => ({
      samples: voice.samples.filter((sample) => sample.key !== key)
    }))
  }

  const removeVoice = (voiceId: string): void => {
    player.stop()
    setEditing((open) => ({ ...open, [voiceId]: null }))
    setRemoving(null)
    setNames((typed) => {
      const rest = { ...typed }
      delete rest[voiceId]
      return rest
    })
    queue.updateVoices(file.id, (list) => list.filter((voice) => voice.id !== voiceId))
  }

  const addVoice = (): void => {
    // kiChat takes the names typed before it adds the voice.
    const voice = manualVoice(voices, autoLabel)
    queue.updateVoices(file.id, (list) => [...withNames(list), voice])
    setNames({})
    setAdded(voice.id)
  }

  const setColor = (voiceId: string, colorId: NonNullable<VoiceDraft['colorId']>): void => {
    // Picking a colour takes the names typed too (kiChat's avatar picker).
    queue.updateVoices(file.id, (list) =>
      withNames(list).map((voice) => (voice.id === voiceId ? { ...voice, colorId } : voice))
    )
    setNames({})
  }

  const reanalyze = async (): Promise<void> => {
    player.stop()
    setEditing({})
    setRemoving(null)
    // kiChat says `Analysiere...` until the server answers that the analysis runs.
    setReanalysis('starting')
    const outcome = await queue.reanalyze(file.id, {
      keepVoices: false,
      onPoll: () => setReanalysis('polling')
    })
    setReanalysis(null)
    if (outcome.ok) {
      // The new voices come with their automatic names (T-21).
      setNames({})
      return
    }
    await dialogs.alert({
      title: t('transcription.common.error'),
      message: `${t('transcription.upload.speakerAnalysisRetryFailed')}${
        outcome.message ?? t('transcription.common.unknown')
      }`
    })
  }

  const save = (): void => {
    player.stop()
    queue.saveVoices(file.id, withNames(voices))
    setSaved(true)
    closeTimer.current = setTimeout(onClose, SAVED_MS)
  }

  const reanalysisLabel =
    reanalysis === 'starting'
      ? t('transcription.upload.analyzingShort')
      : t('transcription.upload.analyzingSpeakers')

  return (
    <DialogContent
      closeLabel={t('transcription.common.close')}
      // DS gap: DialogContent has no height cap of its own; the voices scroll in it. One shrinkable
      // column keeps long names inside.
      className="max-h-9/10 grid-cols-1 overflow-y-auto sm:max-w-2xl"
      // As kiChat's modal, only Close and Save end it: Escape and a click beside it do not.
      onEscapeKeyDown={(event) => {
        event.preventDefault()
        player.stop()
      }}
      onInteractOutside={(event) => event.preventDefault()}
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
              <Spinner size="sm" label={reanalysisLabel} />
            ) : (
              <RefreshCwIcon {...ICON} />
            )}
            {reanalyzing ? reanalysisLabel : t('transcription.upload.repeatAnalysis')}
          </Button>
        </div>
      </DialogHeader>

      {player.failed ? (
        <Notice tone="error" title={t('transcription.upload.mapping.audioUnavailable')} />
      ) : null}
      {/* Audio not decoded here, without the server's waveform: the sample tracks draw placeholders
      (T-12). */}
      {loadedPeaks === null &&
      !decodesLocally({ size: file.size, type: file.mimeType, name: file.name }, file.duration) ? (
        <Badge appearance="text">{t('transcription.common.player.waveformUnavailable')}</Badge>
      ) : null}

      <div aria-busy={reanalyzing || undefined} className="flex flex-col gap-stack-md">
        {voices.length === 0 ? (
          <Badge appearance="text">{t('transcription.upload.mapping.noVoices')}</Badge>
        ) : null}
        {voices.map((voice, index) => (
          <VoiceCard
            key={voice.id}
            voice={voice}
            name={names[voice.id] ?? voice.name}
            index={index}
            duration={duration}
            peaks={peaks}
            player={player}
            editing={editing[voice.id] ?? null}
            removing={removing === voice.id}
            focusName={added === voice.id}
            disabled={reanalyzing}
            onName={(name) => setNames((typed) => ({ ...typed, [voice.id]: name }))}
            onColor={(colorId) => setColor(voice.id, colorId)}
            onRemove={() => setRemoving(voice.id)}
            onCancelRemove={() => setRemoving(null)}
            onConfirmRemove={() => removeVoice(voice.id)}
            onSample={(sample) => {
              // A chip plays its sample; every open sample detail closes (kiChat).
              setEditing({})
              player.toggle(sample.key, sample.start, sample.end)
            }}
            onEdit={(sample) => {
              // Opens or closes this voice's detail only; other voices keep theirs (kiChat).
              player.stop()
              setEditing((open) => ({
                ...open,
                [voice.id]: open[voice.id] === sample.key ? null : sample.key
              }))
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
  /** The name shown: the one typed, else the voice's. */
  name: string
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
  const voiceName = props.name.trim() || placeLabel
  const atLimit = !canAddSample(voice)
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
              value={props.name}
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
                  // Marks the chip for the dialog's click listener that stops a preview.
                  data-sample-key={sample.key}
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
            aria-describedby={atLimit ? `${id}-limit` : undefined}
            title={
              atLimit
                ? t('transcription.upload.mapping.samplesLimit', {
                    max: TRANSCRIPTION_SAMPLES_PER_SPEAKER_MAX
                  })
                : t('transcription.upload.addSnippet')
            }
            disabled={props.disabled || atLimit}
            onClick={props.onAddSample}
          >
            <PlusIcon {...ICON} />
          </Button>
          {/* kiChat has no limit; the contract's guard against abuse is said, not silent. */}
          {atLimit ? (
            <Badge id={`${id}-limit`} appearance="text">
              {t('transcription.upload.mapping.samplesLimit', {
                max: TRANSCRIPTION_SAMPLES_PER_SPEAKER_MAX
              })}
            </Badge>
          ) : null}
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
