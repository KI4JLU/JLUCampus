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
import { Button } from '@ki4jlu/design-system'
import type { TranscriptionSourceFile } from '@justcampus/shared'
import { mediaUrlExpiresSoon, useJobAudioUrl } from '../api'
import {
  formatTime,
  globalPeaks,
  sourceWaveform,
  WaveformPlayer,
  type DecodedWaveform,
  type WaveformPlayerHandle,
  type WaveformSegment,
  type WaveformTimeline
} from '../audio'
import { playbackStep, sourceIndexAt, toLocalTime, type SpeakerBlock } from '../segments'
import { useSpeakerLabel } from './use-speaker-label'

/** What the transcript does with the player: all times are global, over every source file. */
export interface GlobalPlayerHandle {
  seek: (time: number) => void
  /** Plays from `start` on, as kiChat's avatar of a block does in both tabs. */
  play: (start: number) => void
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

/** The waveform of every source file, by file; `null` where there is none. */
interface SourceWaveforms {
  sources: readonly TranscriptionSourceFile[]
  waveforms: (DecodedWaveform | null)[]
}

/**
 * The result's global player (T-24), after kiChat's `initGlobalAudioPlayer` and its global
 * `CustomAudioPlayer`: one waveform over the merged time line of all source files, with the
 * speakers' time line (hover names a speaker's stretch), play and pause, and seeking anywhere on
 * it by pointer or keys, which changes files on its own. Each file's audio comes from a fresh
 * audio URL of its job, fetched again before it expires and when playback fails. Playback keeps to
 * the saved ranges (`playbackStep`): at a file's saved end the next one plays on, also when its
 * audio runs longer. Files above 100 MB are not decoded; their part shows the waveform the
 * analysis computed.
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
  const speakerLabel = useSpeakerLabel()
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
  /** Set while the next file is being loaded, so the hand-over happens once. */
  const switching = useRef(false)
  const [loaded, setLoaded] = useState<SourceWaveforms | null>(null)
  const waveforms = loaded?.sources === sources ? loaded.waveforms : null

  // Every file's waveform, placed on the global time line like kiChat's `computeWaveformPeaks`.
  useEffect(() => {
    let cancelled = false
    void Promise.all(
      sources.map((file) => (file.jobId ? sourceWaveform(file.jobId, file) : null))
    ).then((results) => {
      if (!cancelled) setLoaded({ sources, waveforms: results })
    })
    return () => {
      cancelled = true
    }
  }, [sources])

  const peaks = useMemo(
    () =>
      waveforms
        ? globalPeaks(
            sources,
            waveforms.map((waveform) => waveform?.peaks ?? null),
            total
          )
        : null,
    [sources, waveforms, total]
  )

  // The speakers' time line over all files, global like the bar.
  const segments = useMemo<WaveformSegment[]>(
    () =>
      blocks.map((block) => ({
        start: block.start,
        end: block.end,
        colorId: block.colorId,
        label: speakerLabel(block.speaker)
      })),
    [blocks, speakerLabel]
  )

  // The transcript forgets the playing state and block when the player goes.
  const report = useRef({ onTime, onPlayingChange })
  useEffect(() => {
    report.current = { onTime, onPlayingChange }
  })
  useEffect(
    () => () => {
      report.current.onPlayingChange(false)
      report.current.onTime(-1)
    },
    []
  )

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

  /**
   * Fetches the playing file's audio URL anew; a waiting action applies once its audio reported
   * its length again (`onDuration`). The backend's URLs stay the same, and the element does not
   * load an unchanged source by itself, so it is told to.
   */
  const reload = useCallback(async () => {
    const before = media?.url
    const result = await refetchAudio()
    const element = wave.current?.audio()
    if (!before || result.isError || result.data?.url !== before) return
    // Unless another file was loaded meanwhile.
    if (element?.getAttribute('src') === before) element.load()
  }, [media, refetchAudio])

  const go = useCallback(
    (global: number, play: boolean) => {
      const target = sourceIndexAt(sources, global)
      const file = sources[target]
      if (!file) return
      // The bar and the transcript follow at once, also while another file loads.
      setTime(global)
      onTime(global)
      pending.current = { local: toLocalTime(file, global), play }
      if (target !== index) {
        ready.current = false
        setIndex(target)
      } else if (media && mediaUrlExpiresSoon(media)) {
        ready.current = false
        void reload()
      } else apply()
    },
    [sources, index, media, reload, apply, onTime]
  )

  const onDuration = useCallback(() => {
    ready.current = true
    apply()
  }, [apply])

  useImperativeHandle(
    ref,
    () => ({
      seek: (global) => go(global, false),
      play: (start) => go(start, true),
      pause: () => wave.current?.pause()
    }),
    [go]
  )

  /**
   * Shows the time of the playing file's `local` second on the global time line and keeps
   * playback to the saved ranges: the next file at a file's saved end, a stop at the last one's.
   */
  const follow = useCallback(
    (local: number) => {
      // While another file loads, the old one's time does not count.
      if (switching.current || pending.current) return
      const step = playbackStep(sources, index, local, null, null)
      setTime(step.time)
      onTime(step.time)
      if (!playing.current) return
      if (step.kind === 'stop') {
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
      void reload()
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
  }, [index, sources, reload, load])

  if (sources.length === 0) {
    return <p className="m-0">{t('transcription.result.noAudio')}</p>
  }

  const name = source?.name ?? ''
  const timeline: WaveformTimeline = {
    peaks,
    duration: total,
    time,
    onSeek: (global) => go(global, playing.current),
    sourceDuration:
      waveforms?.[index]?.duration ??
      source?.duration ??
      (source ? source.endTime - source.startTime : undefined)
  }
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        {/* The file playing now; the bar spans all of them. */}
        <span className="min-w-0 truncate">{name}</span>
        <span className="shrink-0">{`${formatTime(time)} / ${formatTime(total)}`}</span>
      </div>
      <WaveformPlayer
        ref={wave}
        source={media?.url ?? null}
        name={name}
        size={source?.size || undefined}
        jobId={source?.jobId ?? null}
        segments={segments}
        timeline={timeline}
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
              ready.current = false
              void reload()
            }}
          >
            {t('transcription.common.retry')}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
