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
  playbackStep,
  sourceIndexAt,
  sourceTimeline,
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
}

/**
 * The result's global player (T-24), after kiChat's `initGlobalAudioPlayer`: a waveform with the
 * speakers' time line, play and pause, seeking and the time over all source files of the
 * transcript. Each file's audio comes from a fresh audio URL of its job, fetched again before it
 * expires and when playback fails. Playback keeps to the saved ranges (`playbackStep`): at a
 * file's saved end the next one plays on, also when its audio runs longer, and a block played in
 * Corrections stops at its end in whichever file that lies. Above 100 MB the waveform is not
 * decoded, the audio still plays.
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
  const [active, setActive] = useState(false)
  /** The global end of the block being played, across files; `null` plays on. */
  const rangeEnd = useRef<number | null>(null)
  /** The global time shown last, to tell when the block's end is crossed. */
  const shown = useRef<number | null>(null)
  /** Set while the next file is being loaded, so the hand-over happens once. */
  const switching = useRef(false)
  const timeline = useMemo(() => sourceTimeline(blocks, source), [blocks, source])

  const apply = useCallback(() => {
    const action = pending.current
    const player = wave.current
    if (!action || !player || !ready.current) return
    pending.current = null
    switching.current = false
    player.seek(action.local)
    if (action.play) void player.play()
  }, [])

  /** Loads another file and plays or shows it from `local` once it is ready. */
  const load = useCallback((target: number, local: number, play: boolean) => {
    pending.current = { local, play }
    ready.current = false
    setIndex(target)
  }, [])

  const go = useCallback(
    (global: number, play: boolean, end: number | null) => {
      const target = sourceIndexAt(sources, global)
      const file = sources[target]
      if (!file) return
      rangeEnd.current = play ? end : null
      shown.current = null
      pending.current = { local: toLocalTime(file, global), play }
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

  /**
   * Shows the time of the playing file's `local` second on the global time line and keeps
   * playback to the saved ranges: the next file at a file's saved end, a stop at a block's end.
   */
  const follow = useCallback(
    (local: number) => {
      const step = playbackStep(sources, index, local, rangeEnd.current, shown.current)
      shown.current = step.time
      setTime(step.time)
      onTime(step.time)
      if (!playing.current || switching.current) return
      if (step.kind === 'stop') {
        rangeEnd.current = null
        wave.current?.pause()
        // At the saved end of the last file the audio counts as ended, so the next play starts it
        // from the beginning instead of stopping again at once.
        const element = wave.current?.audio()
        if (step.last && element && Number.isFinite(element.duration)) {
          element.currentTime = element.duration
        }
      } else if (step.kind === 'next') {
        switching.current = true
        wave.current?.pause()
        load(step.index, step.local, true)
      }
    },
    [sources, index, onTime, load]
  )

  // While playing, the boundaries are checked every frame; `timeupdate` alone is too coarse.
  useEffect(() => {
    if (!active) return
    let frame = 0
    const tick = (): void => {
      const player = wave.current
      if (player) follow(player.currentTime())
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [active, follow])

  // The next file when a file's audio ends before its saved end; a fresh URL when the audio fails
  // (an expired signature).
  useEffect(() => {
    const element = wave.current?.audio()
    if (!element) return
    const onEnded = (): void => {
      if (index >= sources.length - 1 || switching.current) return
      const next = sources[index + 1]!
      switching.current = true
      load(index + 1, toLocalTime(next, sources[index]!.endTime), true)
    }
    const onError = (): void => {
      if (!element.getAttribute('src')) return
      if (retried.current) {
        setFailed(true)
        return
      }
      retried.current = true
      pending.current = { local: element.currentTime, play: playing.current }
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
  }, [index, sources, refetchAudio, load])

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
        jobId={source?.jobId ?? null}
        segments={timeline}
        compact
        onTimeUpdate={follow}
        onPlayingChange={(value) => {
          playing.current = value
          setActive(value)
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
