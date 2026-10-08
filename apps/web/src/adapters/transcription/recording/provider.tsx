import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  isTranscriptionLiveErrorCode,
  TRANSCRIPTION_LIVE_FONT_SIZE,
  type TranscriptionRealtimeMode
} from '@justcampus/shared'
import { meQuery } from '@/lib/queries'
import { liveSocketUrl, useRealtimeConfig } from '../api'
import { startPcmCapture } from '../live/audio'
import {
  appendLiveTranscriptText,
  EMPTY_LIVE_TRANSCRIPT_WINDOW,
  type LiveTranscriptWindow
} from '../live/lines'
import { RealtimeError, RealtimeSession, type RealtimeDependencies } from '../live/session'
import { useMemoryCell } from '../page-memory'
import { useTranscriptionWorkspace } from '../use-workspace'
import { WidgetTargetReceiver } from '../widgets/target'
import { RecordingContext, type LiveAppearance, type RecordedTake, type Recording } from './context'
import { audioConstraint, DEFAULT_DEVICE_ID } from './devices'
import { releaseStream, startLocalRecorder, type LocalRecorder } from './local-recorder'
import {
  INITIAL_RECORDING_STATE,
  recordingReducer,
  type RecordingAction,
  type RecordingKind,
  type RecordingState
} from './state'
import { useMicrophones } from './use-microphones'
import { recordingFilename, recordingToWav, recordingUsername } from './wav'

const DEFAULT_APPEARANCE: LiveAppearance = {
  fontSize: TRANSCRIPTION_LIVE_FONT_SIZE.default,
  inverted: false,
  maximized: false
}

/** The server's live WebSocket and the browser's audio worklet. */
const browserRealtime: RealtimeDependencies = {
  openSocket: (mode) => new WebSocket(liveSocketUrl(mode)),
  capture: startPcmCapture
}

/** What runs: the microphone stream, its local recorder and, live, the realtime session. */
interface RunningSession {
  kind: RecordingKind
  stream: MediaStream
  recorder: LocalRecorder | null
  realtime: RealtimeSession | null
  startedAt: number
}

function errorName(error: unknown): string {
  return typeof error === 'object' && error !== null && 'name' in error
    ? String((error as { name: unknown }).name)
    : ''
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : ''
}

/** A mutable box in the page's memory, as `useRef` but kept across a remount of the page. */
interface Box<T> {
  current: T
}

/**
 * Holds the microphone choice, the recorded takes and the live session for as long as the page
 * lives, so they survive switching between recording, live transcription and other views, and a
 * remount of the page (`page-memory.ts`). Takes stay in memory only: leaving the page drops them
 * and releases the microphone (T-57).
 */
export function RecordingProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const { t } = useTranslation()
  const { capabilities, enqueueUpload, memory } = useTranscriptionWorkspace()
  const me = useQuery(meQuery).data
  const microphones = useMicrophones()
  const [state, setState] = useMemoryCell(
    memory.cell<RecordingState>('recording.state', () => INITIAL_RECORDING_STATE)
  )
  const dispatch = useCallback(
    (action: RecordingAction) => setState((current) => recordingReducer(current, action)),
    [setState]
  )
  const takesCell = memory.cell<RecordedTake[]>('recording.takes', () => [])
  const [takes, setTakesState] = useMemoryCell(takesCell)
  const takesRef: Box<RecordedTake[]> = useMemo(
    () => ({
      get current() {
        return takesCell.value
      }
    }),
    [takesCell]
  )

  const liveOffered = (capabilities?.realtimeModes.length ?? 0) > 0
  const config = useRealtimeConfig(liveOffered).data
  const modes = useMemo(() => config?.modes ?? [], [config])
  const [chosenMode, setMode] = useMemoryCell(
    memory.cell<TranscriptionRealtimeMode | null>('recording.mode', () => null)
  )
  const mode =
    chosenMode && modes.includes(chosenMode)
      ? chosenMode
      : (config?.defaultMode ?? modes[0] ?? null)
  const [text, setTextState] = useMemoryCell(memory.cell('recording.text', () => ''))
  const [subtitles, setSubtitles] = useMemoryCell(
    memory.cell<LiveTranscriptWindow>('recording.subtitles', () => EMPTY_LIVE_TRANSCRIPT_WINDOW)
  )
  const [liveStarted, setLiveStarted] = useMemoryCell(
    memory.cell('recording.liveStarted', () => false)
  )
  // The subtitles are kept chunk by chunk beside the text: where a chunk ends decides the trimming.
  const appendText = useCallback(
    (chunk: string) => {
      setTextState((current) => current + chunk)
      setSubtitles((current) => appendLiveTranscriptText(current, chunk))
    },
    [setTextState, setSubtitles]
  )
  const resetText = useCallback(() => {
    setTextState('')
    setSubtitles(EMPTY_LIVE_TRANSCRIPT_WINDOW)
  }, [setTextState, setSubtitles])
  const [serviceError, setServiceError] = useMemoryCell(
    memory.cell<string | null>('recording.serviceError', () => null)
  )
  const [appearance, setAppearanceState] = useMemoryCell(
    memory.cell<LiveAppearance>('recording.appearance', () => DEFAULT_APPEARANCE)
  )

  // Boxes in the page's memory: what runs belongs to the page, not to one mount of it.
  const [{ session: sessionRef, stopping: stoppingRef, busy: busyRef, mounted: mountedRef }] =
    useState(
      () =>
        memory.cell('recording.boxes', () => {
          const boxes = {
            session: { current: null } as Box<RunningSession | null>,
            stopping: { current: null } as Box<Promise<void> | null>,
            /** Set from the first click to the end of stopping, so nothing starts twice. */
            busy: { current: false } as Box<boolean>,
            /** Until the page is left for good. */
            mounted: { current: true } as Box<boolean>
          }
          // Leaving the page drops what runs without finishing it, and frees the microphone.
          memory.onDispose(() => {
            boxes.mounted.current = false
            const running = boxes.session.current
            boxes.session.current = null
            running?.recorder?.discard()
            running?.realtime?.teardown()
            releaseStream(running?.stream ?? null)
            boxes.busy.current = false
          })
          return boxes
        }).value
    )

  const setTakes = useCallback((next: RecordedTake[]) => setTakesState(next), [setTakesState])

  const fail = useCallback(
    (message: string) => {
      busyRef.current = false
      if (mountedRef.current)
        dispatch({ type: 'failed', error: message, takes: takesRef.current.length })
    },
    [busyRef, dispatch, mountedRef, takesRef]
  )

  const realtimeErrorText = useCallback(
    (error: unknown): string => {
      if (!(error instanceof RealtimeError))
        return errorText(error) || t('transcription.recording.errors.connectionFailed')
      // Why the server did not take the session, in the app's words.
      if (error.code === 'refused' && error.detail)
        return t(`transcription.recording.liveErrors.${error.detail}`)
      if (error.code === 'refused') return t('transcription.recording.errors.connectionFailed')
      return t(`transcription.recording.errors.${error.code}`)
    },
    [t]
  )

  /** Ends the running recording; `lost` is the error that ended it from outside. */
  const finish = useCallback(
    (lost: string | null): Promise<void> => {
      if (stoppingRef.current) return stoppingRef.current
      const running = sessionRef.current
      if (!running?.recorder) return Promise.resolve()
      const recorder = running.recorder
      dispatch({ type: 'stop' })
      stoppingRef.current = (async () => {
        let error = lost
        let take: RecordedTake | null = null
        try {
          const recorded = recorder.stop()
          // Live: the bridge finishes its transcripts while the take is converted.
          const draining = running.realtime?.stop() ?? Promise.resolve()
          let converting: Promise<File> | null = null
          try {
            const blob = await recorded
            const filename = recordingFilename(
              recordingUsername(me ?? null),
              new Date(running.startedAt)
            )
            converting = recordingToWav(blob, filename)
            // Awaited after the drain; until then a failure must not count as unhandled.
            converting.catch(() => undefined)
          } catch {
            error ??= t('transcription.recording.stopRecordingFailed')
          }
          await draining
          if (converting) {
            try {
              take = { id: crypto.randomUUID(), file: await converting }
            } catch {
              error ??= t('transcription.recording.recordingProcessFailed')
            }
          }
        } finally {
          releaseStream(running.stream)
          if (sessionRef.current === running) sessionRef.current = null
        }
        if (!mountedRef.current) return
        const next = take ? [...takesRef.current, take] : takesRef.current
        if (take) setTakes(next)
        busyRef.current = false
        dispatch(
          error
            ? { type: 'failed', error, takes: next.length }
            : { type: 'stopped', takes: next.length }
        )
      })().finally(() => {
        stoppingRef.current = null
      })
      return stoppingRef.current
    },
    [busyRef, dispatch, me, mountedRef, sessionRef, setTakes, stoppingRef, t, takesRef]
  )

  const stop = useCallback(() => finish(null), [finish])
  // Device and connection events call the current `finish`, not the one of the start.
  const [finishRef] = useState(
    () => memory.cell<Box<typeof finish>>('recording.finish', () => ({ current: finish })).value
  )
  useEffect(() => {
    finishRef.current = finish
  })

  const start = useCallback(
    async (kind: RecordingKind): Promise<void> => {
      if (busyRef.current) return
      busyRef.current = true
      dispatch({ type: 'request', kind })

      const devices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices
      if (!devices?.getUserMedia) {
        fail(t('transcription.recording.microphoneAccessUnsupported'))
        return
      }
      if (kind === 'live' && !mode) {
        fail(t('transcription.recording.liveUnavailable'))
        return
      }

      let stream: MediaStream
      try {
        stream = await devices.getUserMedia({ audio: audioConstraint(microphones.selected) })
      } catch (error) {
        const name = errorName(error)
        if (
          name === 'NotAllowedError' ||
          name === 'PermissionDeniedError' ||
          name === 'SecurityError'
        )
          fail(t('transcription.recording.microphonePermissionDenied') + errorText(error))
        else {
          // The chosen device is gone or busy: the next start tries the default input.
          if (name === 'NotFoundError' || name === 'OverconstrainedError')
            microphones.select(DEFAULT_DEVICE_ID)
          fail(errorText(error) || t('transcription.recording.startRecordingFailed'))
        }
        return
      }
      if (!mountedRef.current) {
        releaseStream(stream)
        return
      }
      microphones.markGranted()

      let realtime: RealtimeSession | null = null
      if (kind === 'live' && mode) {
        dispatch({ type: 'connect' })
        // A new session starts with an empty transcript (T-61); the sample text does not return.
        resetText()
        setLiveStarted(true)
        setServiceError(null)
        realtime = new RealtimeSession(
          {
            onText: appendText,
            onServiceError: (message) =>
              setServiceError(
                isTranscriptionLiveErrorCode(message)
                  ? t(`transcription.recording.liveErrors.${message}`)
                  : t('transcription.recording.liveServiceError', { message })
              ),
            // As in kiChat, only the text stops: the microphone and the local recorder go on,
            // and stopping as usual keeps the whole take.
            onConnectionLost: (code) => {
              const running = sessionRef.current
              if (running?.realtime === realtime) running.realtime = null
              setServiceError(t(`transcription.recording.errors.${code}`))
            }
          },
          browserRealtime
        )
        sessionRef.current = { kind, stream, recorder: null, realtime, startedAt: Date.now() }
        try {
          await realtime.start({ stream, mode })
        } catch (error) {
          releaseStream(stream)
          if (sessionRef.current?.realtime === realtime) sessionRef.current = null
          if (mountedRef.current) fail(realtimeErrorText(error))
          return
        }
        if (!mountedRef.current || sessionRef.current?.realtime !== realtime) return
      }

      let recorder: LocalRecorder
      try {
        recorder = startLocalRecorder(stream)
      } catch (error) {
        realtime?.teardown()
        releaseStream(stream)
        sessionRef.current = null
        fail(errorText(error) || t('transcription.recording.startRecordingFailed'))
        return
      }
      const startedAt = Date.now()
      sessionRef.current = { kind, stream, recorder, realtime, startedAt }
      // A microphone that disappears ends the take with what it recorded (T-55).
      for (const track of stream.getAudioTracks())
        track.addEventListener('ended', () => void finishRef.current(null), { once: true })
      dispatch({ type: 'started', at: startedAt })
    },
    [
      busyRef,
      dispatch,
      fail,
      finishRef,
      microphones,
      mode,
      mountedRef,
      realtimeErrorText,
      sessionRef,
      setServiceError,
      appendText,
      resetText,
      setLiveStarted,
      t
    ]
  )

  const deleteTake = useCallback(
    (id: string) => {
      const next = takesRef.current.filter((take) => take.id !== id)
      setTakes(next)
      dispatch({ type: 'takesChanged', takes: next.length })
    },
    [dispatch, setTakes, takesRef]
  )

  const uploadTakes = useCallback(() => {
    const files = takesRef.current.map((take) => take.file)
    if (files.length === 0 || busyRef.current) return
    // Like kiChat, into the first group next to the files already there, through the same queue,
    // validation and analysis as picked files.
    enqueueUpload(files, null, { target: 'first' })
    setTakes([])
    dispatch({ type: 'takesChanged', takes: 0 })
  }, [busyRef, dispatch, enqueueUpload, setTakes, takesRef])

  const setAppearance = useCallback(
    (change: Partial<LiveAppearance>) => {
      setAppearanceState((current) => ({ ...current, ...change }))
    },
    [setAppearanceState]
  )
  const resetAppearance = useCallback(
    () =>
      setAppearanceState((current) => ({ ...DEFAULT_APPEARANCE, maximized: current.maximized })),
    [setAppearanceState]
  )
  const clearText = useCallback(() => {
    resetText()
    setServiceError(null)
  }, [resetText, setServiceError])

  const recording = useMemo<Recording>(
    () => ({
      state,
      microphones,
      takes,
      start,
      stop,
      deleteTake,
      uploadTakes,
      live: {
        config,
        modes,
        mode,
        setMode,
        text,
        subtitles,
        started: liveStarted,
        serviceError,
        clearText,
        appearance,
        setAppearance,
        resetAppearance
      }
    }),
    [
      state,
      microphones,
      takes,
      start,
      stop,
      deleteTake,
      uploadTakes,
      config,
      modes,
      mode,
      setMode,
      text,
      subtitles,
      liveStarted,
      serviceError,
      clearText,
      appearance,
      setAppearance,
      resetAppearance
    ]
  )

  return (
    <RecordingContext.Provider value={recording}>
      <WidgetTargetReceiver />
      {children}
    </RecordingContext.Provider>
  )
}
