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
import { RealtimeError, RealtimeSession, type RealtimeDependencies } from '../live/session'
import { useMemoryCell } from '../page-memory'
import { useTranscriptionWorkspace } from '../use-workspace'
import { WidgetTargetReceiver } from '../widgets/target'
import {
  RecordingContext,
  type LiveAppearance,
  type MeetingRecording,
  type RecordedTake,
  type Recording
} from './context'
import { audioConstraint, DEFAULT_DEVICE_ID } from './devices'
import { releaseStream, startLocalRecorder, type LocalRecorder } from './local-recorder'
import {
  detectMeetingSupport,
  MEETING_AUDIO_BITS_PER_SECOND,
  MEETING_FILE_TYPE,
  MeetingCaptureError,
  meetingMimeType,
  startMeetingCapture,
  type MeetingCapture
} from './meeting-capture'
import {
  claimMeetingLock,
  createMeetingJournal,
  heldMeetingIds,
  holdMeetingLock,
  listStoredMeetings,
  meetingsDirectory,
  readMeetingInfo,
  readStoredMeeting,
  removeStoredMeeting,
  type MeetingJournal,
  type StoredMeeting
} from './meeting-store'
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
  /** Ends the capture: the microphone, for a meeting also the tab's sharing and the mix. */
  release: () => void
  /** A meeting's backup in the browser and the name of its take. */
  meeting: { id: string; filename: string; journal: MeetingJournal } | null
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
 * lives, so they survive switching between recording, live transcription, meetings and other
 * views, and a remount of the page (`page-memory.ts`). Takes stay in memory: leaving the page
 * drops them and releases the microphone (T-57). Meeting takes are also backed up in the
 * browser (`meeting-store.ts`) until uploaded or deleted, so a crash or leaving the page does not
 * lose an hour-long meeting; the meeting tab offers such leftovers again.
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
  const [text, setText] = useMemoryCell(memory.cell('recording.text', () => ''))
  const [serviceError, setServiceError] = useMemoryCell(
    memory.cell<string | null>('recording.serviceError', () => null)
  )
  const [appearance, setAppearanceState] = useMemoryCell(
    memory.cell<LiveAppearance>('recording.appearance', () => DEFAULT_APPEARANCE)
  )

  // Boxes in the page's memory: what runs belongs to the page, not to one mount of it.
  const [
    {
      session: sessionRef,
      stopping: stoppingRef,
      busy: busyRef,
      mounted: mountedRef,
      meetingLocks,
      scanned: scannedRef,
      startingMeeting: startingMeetingRef
    }
  ] = useState(
    () =>
      memory.cell('recording.boxes', () => {
        const boxes = {
          session: { current: null } as Box<RunningSession | null>,
          stopping: { current: null } as Box<Promise<void> | null>,
          /** Set from the first click to the end of stopping, so nothing starts twice. */
          busy: { current: false } as Box<boolean>,
          /** Until the page is left for good. */
          mounted: { current: true } as Box<boolean>,
          /**
           * The releases of the meeting backups this page holds, by meeting: its takes', and an
           * uploaded take's until storage has it.
           */
          meetingLocks: new Map<string, () => void>(),
          /** Whether the backup was searched for leftovers, once per page. */
          scanned: { current: false } as Box<boolean>,
          /** Gives up a meeting capture whose tab picker or microphone prompt is still open. */
          startingMeeting: { current: null } as Box<(() => void) | null>
        }
        // Leaving the page drops what runs without finishing it, and frees the microphone. A
        // meeting's backup stays and is offered again on the next visit.
        memory.onDispose(() => {
          boxes.mounted.current = false
          boxes.startingMeeting.current?.()
          boxes.startingMeeting.current = null
          const running = boxes.session.current
          boxes.session.current = null
          running?.realtime?.teardown()
          // The recorder's last chunk comes after its stop: a meeting's backup gets it before it
          // closes, and only then go the capture and the locks.
          const ended = running?.recorder?.discard() ?? Promise.resolve()
          const meeting = running?.meeting
          const pending = meeting ? ended.then(() => meeting.journal.close()) : ended
          const locks = [...boxes.meetingLocks.values()]
          boxes.meetingLocks.clear()
          void pending.finally(() => {
            running?.release()
            for (const release of locks) release()
          })
          boxes.busy.current = false
        })
        return boxes
      }).value
  )

  const setTakes = useCallback((next: RecordedTake[]) => setTakesState(next), [setTakesState])

  const [meetingSupport] = useState(detectMeetingSupport)
  const [consented, setConsented] = useMemoryCell(
    memory.cell('recording.meetingConsent', () => false)
  )
  const [backupFailed, setBackupFailed] = useMemoryCell(
    memory.cell('recording.meetingBackupFailed', () => false)
  )
  const [leftovers, setLeftovers] = useMemoryCell(
    memory.cell<StoredMeeting[]>('recording.meetingLeftovers', () => [])
  )
  const [leftoverError, setLeftoverError] = useMemoryCell(
    memory.cell<string | null>('recording.meetingLeftoverError', () => null)
  )

  /** Lets go of a meeting's backup: another tab, or the next visit, may offer it. */
  const unlockMeeting = useCallback(
    (id: string) => {
      meetingLocks.get(id)?.()
      meetingLocks.delete(id)
    },
    [meetingLocks]
  )

  /**
   * Deletes a meeting take's backup, once the take is deleted or its upload stored, and lets go of
   * it. A page left meanwhile let go already: it claims the backup again, unless another page took
   * it since.
   */
  const removeMeeting = useCallback(
    async (id: string): Promise<void> => {
      const held = meetingLocks.get(id)
      meetingLocks.delete(id)
      const release = held ?? (await claimMeetingLock(id))
      if (!release) return
      await removeStoredMeeting(meetingsDirectory(), id)
      release()
    },
    [meetingLocks]
  )

  /** Lists the backups no page holds and no take of this page uses. */
  const findLeftovers = useCallback(async (): Promise<void> => {
    const directory = await meetingsDirectory()
    if (!directory) return
    const skip = await heldMeetingIds()
    for (const take of takesRef.current) if (take.meetingId) skip.add(take.meetingId)
    const running = sessionRef.current?.meeting?.id
    if (running) skip.add(running)
    const found: StoredMeeting[] = []
    for (const listed of await listStoredMeetings(directory, skip)) {
      // Each one under its lock: another tab may have started or taken it since the query.
      const release = await claimMeetingLock(listed.id)
      if (!release) continue
      try {
        const meeting = await readMeetingInfo(directory, listed.id)
        // Started but never got a chunk: nothing to offer.
        if (meeting?.chunks === 0) await removeStoredMeeting(Promise.resolve(directory), meeting.id)
        else if (meeting) found.push(meeting)
      } finally {
        release()
      }
    }
    if (mountedRef.current) setLeftovers(found)
  }, [mountedRef, sessionRef, setLeftovers, takesRef])

  // Once per page, where meetings can be recorded at all.
  useEffect(() => {
    if (meetingSupport !== 'supported' || scannedRef.current) return
    scannedRef.current = true
    void findLeftovers()
  }, [findLeftovers, meetingSupport, scannedRef])

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
      const meeting = running.meeting
      const duration = (Date.now() - running.startedAt) / 1000
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
            if (meeting) {
              // A meeting stays WebM: decoding an hour or more for a WAV would take over a
              // gigabyte of memory and exceed the upload limit. WebM is labelled WebM (T-57).
              converting = Promise.resolve(
                new File([blob], meeting.filename, { type: MEETING_FILE_TYPE })
              )
            } else {
              const filename = recordingFilename(
                recordingUsername(me ?? null),
                new Date(running.startedAt)
              )
              converting = recordingToWav(blob, filename)
              // Awaited after the drain; until then a failure must not count as unhandled.
              converting.catch(() => undefined)
            }
          } catch {
            error ??= t('transcription.recording.stopRecordingFailed')
          }
          await draining
          // The backup gets its last chunks and stays until the take is uploaded or deleted.
          await meeting?.journal.close()
          if (converting) {
            try {
              take = {
                id: crypto.randomUUID(),
                file: await converting,
                duration,
                meetingId: meeting?.id
              }
            } catch {
              error ??= t('transcription.recording.recordingProcessFailed')
            }
          }
        } finally {
          running.release()
          if (sessionRef.current === running) sessionRef.current = null
        }
        // Without a take the backup is all there is: offered as a leftover.
        if (meeting && !take) unlockMeeting(meeting.id)
        if (!mountedRef.current) return
        if (meeting && !take) void findLeftovers()
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
    [
      busyRef,
      dispatch,
      findLeftovers,
      me,
      mountedRef,
      sessionRef,
      setTakes,
      stoppingRef,
      t,
      takesRef,
      unlockMeeting
    ]
  )

  const stop = useCallback(() => finish(null), [finish])
  // Device and connection events call the current `finish`, not the one of the start.
  const [finishRef] = useState(
    () => memory.cell<Box<typeof finish>>('recording.finish', () => ({ current: finish })).value
  )
  useEffect(() => {
    finishRef.current = finish
  })

  /** A refused or missing microphone, as a recoverable error (T-55). */
  const failMicrophone = useCallback(
    (error: unknown) => {
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
    },
    [fail, microphones, t]
  )

  /**
   * Asks for the meeting's tab and the microphone, mixes them and records the mix with its
   * backup. Runs straight from the click: `startMeetingCapture` opens the tab picker before
   * anything awaits.
   */
  const startMeeting = useCallback(
    async (devices: MediaDevices): Promise<void> => {
      if (meetingSupport !== 'supported') {
        fail(t('transcription.recording.meeting.unsupported'))
        return
      }
      if (!consented) {
        fail(t('transcription.recording.meeting.consentMissing'))
        return
      }
      const starting = startMeetingCapture(devices, audioConstraint(microphones.selected), () =>
        dispatch({ type: 'microphone' })
      )
      // Leaving the page while a prompt is open gives the start up (`memory.onDispose`).
      startingMeetingRef.current = starting.cancel
      let capture: MeetingCapture
      try {
        capture = await starting.capture
      } catch (error) {
        const failure = error instanceof MeetingCaptureError ? error.failure : 'audio'
        const reason = error instanceof MeetingCaptureError ? error.reason : error
        if (failure === 'cancelled') return
        if (failure === 'microphone') failMicrophone(reason)
        else if (failure === 'noTabAudio') fail(t('transcription.recording.meeting.noTabAudio'))
        else if (failure === 'display')
          fail(
            errorName(reason) === 'NotAllowedError'
              ? t('transcription.recording.meeting.displayCancelled')
              : t('transcription.recording.meeting.displayFailed', { message: errorText(reason) })
          )
        else fail(t('transcription.recording.meeting.audioFailed'))
        return
      } finally {
        if (startingMeetingRef.current === starting.cancel) startingMeetingRef.current = null
      }
      if (!mountedRef.current) {
        capture.release()
        return
      }
      microphones.markGranted()

      const id = crypto.randomUUID()
      const startedAt = Date.now()
      const mimeType = meetingMimeType((type) => MediaRecorder.isTypeSupported(type))
      const meta = {
        id,
        startedAt,
        filename: recordingFilename(recordingUsername(me ?? null), new Date(startedAt), 'webm'),
        mimeType: mimeType ?? MEETING_FILE_TYPE
      }
      setBackupFailed(false)
      // Granted before the first write, so no other tab offers or removes the backup while it
      // grows; the recorder's chunks wait in the journal meanwhile.
      const lock = holdMeetingLock(id)
      meetingLocks.set(id, lock.release)
      // The recording goes on without its backup; the meeting tab says so.
      const directory = lock.held.then(() => meetingsDirectory())
      const journal = createMeetingJournal(directory, meta, () => {
        if (mountedRef.current) setBackupFailed(true)
      })
      let recorder: LocalRecorder
      try {
        recorder = startLocalRecorder(capture.stream, {
          mimeType,
          audioBitsPerSecond: MEETING_AUDIO_BITS_PER_SECOND,
          onChunk: journal.add
        })
      } catch (error) {
        capture.release()
        // After the journal's own writes, so none of them comes back after the removal.
        void journal
          .close()
          .then(() => removeStoredMeeting(directory, id))
          .finally(() => unlockMeeting(id))
        fail(errorText(error) || t('transcription.recording.startRecordingFailed'))
        return
      }
      sessionRef.current = {
        kind: 'meeting',
        stream: capture.stream,
        recorder,
        realtime: null,
        startedAt,
        release: capture.release,
        meeting: { id, filename: meta.filename, journal }
      }
      // The user stopped sharing, closed the meeting's tab or lost the microphone: the take
      // ends with what it recorded.
      for (const track of capture.sources)
        track.addEventListener('ended', () => void finishRef.current(null), { once: true })
      // Agreed for this recording only.
      setConsented(false)
      dispatch({ type: 'started', at: startedAt })
    },
    [
      consented,
      dispatch,
      fail,
      failMicrophone,
      finishRef,
      me,
      meetingLocks,
      meetingSupport,
      microphones,
      mountedRef,
      sessionRef,
      setBackupFailed,
      setConsented,
      startingMeetingRef,
      t,
      unlockMeeting
    ]
  )

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
      if (kind === 'meeting') {
        // Nothing may await before this: the tab picker needs the click (see `startMeeting`).
        await startMeeting(devices)
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
        failMicrophone(error)
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
        // A new session starts with an empty transcript (T-61).
        setText('')
        setServiceError(null)
        realtime = new RealtimeSession(
          {
            onText: (chunk) => setText((current) => current + chunk),
            onServiceError: (message) =>
              setServiceError(
                isTranscriptionLiveErrorCode(message)
                  ? t(`transcription.recording.liveErrors.${message}`)
                  : t('transcription.recording.liveServiceError', { message })
              ),
            onConnectionLost: (code) =>
              void finishRef.current(t(`transcription.recording.errors.${code}`))
          },
          browserRealtime
        )
        sessionRef.current = {
          kind,
          stream,
          recorder: null,
          realtime,
          startedAt: Date.now(),
          release: () => releaseStream(stream),
          meeting: null
        }
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
      sessionRef.current = {
        kind,
        stream,
        recorder,
        realtime,
        startedAt,
        release: () => releaseStream(stream),
        meeting: null
      }
      // A microphone that disappears ends the take with what it recorded (T-55).
      for (const track of stream.getAudioTracks())
        track.addEventListener('ended', () => void finishRef.current(null), { once: true })
      dispatch({ type: 'started', at: startedAt })
    },
    [
      busyRef,
      dispatch,
      fail,
      failMicrophone,
      finishRef,
      microphones,
      mode,
      mountedRef,
      realtimeErrorText,
      sessionRef,
      setServiceError,
      setText,
      startMeeting,
      t
    ]
  )

  const deleteTake = useCallback(
    (id: string) => {
      const meetingId = takesRef.current.find((take) => take.id === id)?.meetingId
      if (meetingId) void removeMeeting(meetingId)
      const next = takesRef.current.filter((take) => take.id !== id)
      setTakes(next)
      dispatch({ type: 'takesChanged', takes: next.length })
    },
    [dispatch, removeMeeting, setTakes, takesRef]
  )

  const uploadTakes = useCallback(() => {
    const taken = takesRef.current
    if (taken.length === 0 || busyRef.current) return
    // A meeting's backup stays, held by this page, until storage has its upload: a refused file, a
    // failed upload or leaving the page meanwhile does not lose it. The files are held weakly.
    const meetings = new WeakMap<File, string>()
    for (const take of taken) if (take.meetingId) meetings.set(take.file, take.meetingId)
    // One normal group, through the same queue, validation and analysis as picked files.
    enqueueUpload(
      taken.map((take) => take.file),
      {
        onStored: (file) => {
          const id = meetings.get(file)
          if (id) void removeMeeting(id)
        }
      }
    )
    setTakes([])
    dispatch({ type: 'takesChanged', takes: 0 })
  }, [busyRef, dispatch, enqueueUpload, removeMeeting, setTakes, takesRef])

  const restoreLeftover = useCallback(
    async (id: string): Promise<void> => {
      const leftover = leftovers.find((entry) => entry.id === id)
      const directory = await meetingsDirectory()
      if (!leftover || !directory) return
      setLeftoverError(null)
      // Another tab may have taken it meanwhile.
      const release = await claimMeetingLock(id)
      if (!release) {
        setLeftovers((current) => current.filter((entry) => entry.id !== id))
        return
      }
      let file: File
      try {
        const blob = await readStoredMeeting(directory, id)
        file = new File([blob], leftover.filename, { type: MEETING_FILE_TYPE })
      } catch {
        release()
        if (mountedRef.current) setLeftoverError(t('transcription.recording.meeting.restoreFailed'))
        return
      }
      if (!mountedRef.current) {
        release()
        return
      }
      meetingLocks.set(id, release)
      const take: RecordedTake = {
        id: crypto.randomUUID(),
        file,
        duration: leftover.duration ?? undefined,
        meetingId: id
      }
      const next = [...takesRef.current, take]
      setTakes(next)
      setLeftovers((current) => current.filter((entry) => entry.id !== id))
      dispatch({ type: 'takesChanged', takes: next.length })
    },
    [
      dispatch,
      leftovers,
      meetingLocks,
      mountedRef,
      setLeftoverError,
      setLeftovers,
      setTakes,
      t,
      takesRef
    ]
  )

  const discardLeftover = useCallback(
    async (id: string): Promise<void> => {
      setLeftoverError(null)
      const release = await claimMeetingLock(id)
      if (release) {
        await removeStoredMeeting(meetingsDirectory(), id)
        release()
      }
      if (mountedRef.current) setLeftovers((current) => current.filter((entry) => entry.id !== id))
    },
    [mountedRef, setLeftoverError, setLeftovers]
  )

  const meeting = useMemo<MeetingRecording>(
    () => ({
      support: meetingSupport,
      consented,
      setConsented,
      backupFailed,
      leftovers,
      restore: restoreLeftover,
      discard: discardLeftover,
      leftoverError
    }),
    [
      meetingSupport,
      consented,
      setConsented,
      backupFailed,
      leftovers,
      restoreLeftover,
      discardLeftover,
      leftoverError
    ]
  )

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
    setText('')
    setServiceError(null)
  }, [setServiceError, setText])

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
        serviceError,
        clearText,
        appearance,
        setAppearance,
        resetAppearance
      },
      meeting
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
      serviceError,
      clearText,
      appearance,
      setAppearance,
      resetAppearance,
      meeting
    ]
  )

  return (
    <RecordingContext.Provider value={recording}>
      <WidgetTargetReceiver />
      {children}
    </RecordingContext.Provider>
  )
}
