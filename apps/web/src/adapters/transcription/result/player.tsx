import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref
} from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@ki4jlu/design-system'
import type { TranscriptionSourceFile } from '@justcampus/shared'
import { mediaUrlExpiresSoon, useJobAudioUrl } from '../api'
import { formatTime, WaveformPlayer, type WaveformPlayerHandle } from '../audio'
import {
  sourceIndexAt,
  sourceTimeline,
  toGlobalTime,
  toLocalTime,
  type SpeakerBlock
} from '../segments'

/** What the transcript does with the player: all times are global, over every source file. */
export interface GlobalPlayerHandle {
  seek: (time: number) => void
  /** Plays from `start`; with `end` it stops there (a block in correction mode). */
  play: (start: number, end?: number) => void
  pause: () => void
}

interface GlobalPlayerProps {
  sources: readonly TranscriptionSourceFile[]
  blocks: readonly SpeakerBlock[]
  /** Seconds of the whole transcript. */
  total: number
  onTime: (time: number) => void
  onPlayingChange: (playing: boolean) => void
  ref?: Ref<GlobalPlayerHandle>
}

interface PendingAction {
  local: number
  play: boolean
  end: number | null
}

/**
 * The result's global player (T-24), after kiChat's `initGlobalAudioPlayer`: a waveform with the
 * speakers' time line, play and pause, seeking and the time over all source files of the
 * transcript. Each file's audio comes from a fresh signed URL of its job, fetched again before it
 * expires and when playback fails; at a file's end the next one plays on. Above 100 MB the
 * waveform is not decoded, the audio still plays.
 */
export function GlobalPlayer({
  sources,
  blocks,
  total,
  onTime,
  onPlayingChange,
  ref
}: GlobalPlayerProps): React.JSX.Element {
  const { t } = useTranslation()
  const [index, setIndex] = useState(0)
  const [time, setTime] = useState(0)
  const [failed, setFailed] = useState(false)
  const source = sources[index] ?? null
  const audio = useJobAudioUrl(source?.jobId ?? null)
  const refetchAudio = audio.refetch
  const media = audio.data
  const wave = useRef<WaveformPlayerHandle>(null)
  const pending = useRef<PendingAction | null>(null)
  const ready = useRef(false)
  const retried = useRef(false)
  const playing = useRef(false)
  const timeline = useMemo(() => sourceTimeline(blocks, source), [blocks, source])

  const apply = useCallback(() => {
    const action = pending.current
    const player = wave.current
    if (!action || !player || !ready.current) return
    pending.current = null
    if (!action.play) player.seek(action.local)
    else if (action.end !== null) void player.playRange(action.local, action.end)
    else {
      player.seek(action.local)
      void player.play()
    }
  }, [])

  const go = useCallback(
    (global: number, play: boolean, end: number | null) => {
      const target = sourceIndexAt(sources, global)
      const file = sources[target]
      if (!file) return
      pending.current = {
        local: toLocalTime(file, global),
        play,
        end: end === null ? null : toLocalTime(file, Math.min(end, file.endTime))
      }
      if (target !== index) {
        ready.current = false
        setIndex(target)
      } else if (media && mediaUrlExpiresSoon(media)) {
        ready.current = false
        void refetchAudio()
      } else apply()
    },
    [sources, index, media, refetchAudio, apply]
  )

  const onDuration = useCallback(() => {
    ready.current = true
    apply()
  }, [apply])

  useImperativeHandle(
    ref,
    () => ({
      seek: (global) => go(global, false, null),
      play: (start, end) => go(start, true, end ?? null),
      pause: () => wave.current?.pause()
    }),
    [go]
  )

  // The next file at a file's end; a fresh URL when the audio fails (an expired signature).
  useEffect(() => {
    const element = wave.current?.audio()
    if (!element) return
    const onEnded = (): void => {
      if (index >= sources.length - 1) return
      pending.current = { local: 0, play: true, end: null }
      ready.current = false
      setIndex(index + 1)
    }
    const onError = (): void => {
      if (!element.getAttribute('src')) return
      if (retried.current) {
        setFailed(true)
        return
      }
      retried.current = true
      pending.current = { local: element.currentTime, play: playing.current, end: null }
      ready.current = false
      void refetchAudio()
    }
    const onPlaying = (): void => {
      retried.current = false
    }
    element.addEventListener('ended', onEnded)
    element.addEventListener('error', onError)
    element.addEventListener('playing', onPlaying)
    return () => {
      element.removeEventListener('ended', onEnded)
      element.removeEventListener('error', onError)
      element.removeEventListener('playing', onPlaying)
    }
  }, [index, sources.length, refetchAudio])

  if (sources.length === 0) {
    return <p className="m-0">{t('transcription.result.noAudio')}</p>
  }

  const name = source?.name ?? ''
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        {sources.length > 1 ? (
          <Select
            value={String(index)}
            onValueChange={(value) => {
              const file = sources[Number(value)]
              if (file) go(file.startTime, playing.current, null)
            }}
          >
            <SelectTrigger aria-label={t('transcription.result.audioFile')} className="max-w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sources.map((file, position) => (
                <SelectItem key={`${file.jobId ?? 'none'}-${position}`} value={String(position)}>
                  {file.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="min-w-0 truncate">{name}</span>
        )}
        <span className="shrink-0">{`${formatTime(time)} / ${formatTime(total)}`}</span>
      </div>
      <WaveformPlayer
        ref={wave}
        source={media?.url ?? null}
        name={name}
        size={source?.size || undefined}
        segments={timeline}
        compact
        onTimeUpdate={(local) => {
          if (!source) return
          const global = toGlobalTime(source, local)
          setTime(global)
          onTime(global)
        }}
        onPlayingChange={(value) => {
          playing.current = value
          onPlayingChange(value)
        }}
        onDuration={onDuration}
      />
      {source && !source.jobId ? <p className="m-0">{t('transcription.result.noAudio')}</p> : null}
      {audio.isError || failed ? (
        <div className="flex flex-wrap items-center gap-2">
          <span>{t('transcription.result.audioFailed')}</span>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setFailed(false)
              retried.current = false
              void refetchAudio()
            }}
          >
            {t('transcription.common.retry')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
