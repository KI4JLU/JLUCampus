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
import {
  backupDirectory,
  claimBackupLock,
  createBackupJournal,
  heldBackupIds,
  holdBackupLock,
  listStoredRecordings,
  readStoredInfo,
  readStoredRecording,
  readStoredTracks,
  removeStoredRecording,
  removeStoredTracks,
  trackDirectory,
  type BackupJournal,
  type StoredRecording
} from './backup-store'
import {
  RecordingContext,
  type LiveAppearance,
  type LiveMicrophone,
  type MicrophoneOption,
  type RecordedTake,
  type Recording,
  type RecordingBackup,
  type RecordingSources
} from './context'
import { audioConstraint, DEFAULT_DEVICE_ID } from './devices'
import {
  detectDisplaySupport,
  DisplayCaptureError,
  startDisplayCapture,
  type DisplayAudio
} from './display-capture'
import {
  recorderMimeType,
  RECORDING_AUDIO_BITS_PER_SECOND,
  recordingFilename,
  recordingFormat,
  recordingUsername
} from './files'
import { releaseStream, startLocalRecorder, type LocalRecorder } from './local-recorder'
import { AudioMixer } from './mixer'
import {
  addableMicrophones,
  canRemoveSource,
  goneMicrophones,
  INITIAL_SOURCES,
  MAIN_SOURCE_ID,
  mainSuccessor,
  sourcesReducer,
  startupMicrophoneOwner,
  type RecordingSource,
  type SourceKind,
  type SourcesAction,
  type SourcesState
} from './sources'
import {
  INITIAL_RECORDING_STATE,
  recordingReducer,
  type RecordingAction,
  type RecordingKind,
  type RecordingState
} from './state'
import { TakeTracks, trackFiles, trackOffset } from './tracks'
import { useMicrophones } from './use-microphones'

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

/**
 * What runs: the recorder and its backup; for regular recording the mix of the sources (their
 * streams are in `inputs`), live the microphone it sends and the realtime session.
 */
interface RunningSession {
  kind: RecordingKind
  recorder: LocalRecorder
  realtime: RealtimeSession | null
  startedAt: number
  mixer: AudioMixer | null
  /** Live: the microphone. */
  stream: MediaStream | null
  /** The take's file, named and typed after what the recorder writes. */
  filename: string
  fileType: string
  backup: { id: string; journal: BackupJournal }
  /** Regular recording: each source in the mix on its own. */
  tracks: TakeTracks | null
}

/** An open source of regular recording, by source id (`MAIN_SOURCE_ID` the main microphone). */
interface Input {
  stream: MediaStream
  kind: SourceKind
}

/** The open sources' streams by id, as the mix takes them. */
function inputStreams(inputs: ReadonlyMap<string, Input>): Map<string, MediaStream> {
  return new Map([...inputs].map(([id, input]) => [id, input.stream]))
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
 * Holds the microphone choice, the sources, the recorded takes and the live session for as long
 * as the page lives, so they survive switching between recording, live transcription and other
 * views, and a remount of the page (`page-memory.ts`). Leaving the page releases every source.
 * Takes stay in memory and are backed up in the browser (`backup-store.ts`) until uploaded or
 * deleted, so a crash or leaving the page does not lose an hour-long recording; the record tab
 * offers such leftovers again.
 *
 * Regular recording mixes the main microphone and the added sources (`mixer.ts`) and records the
 * mix; sources come and go while it runs, and the take ends only when none is left. Live
 * transcription sends and records the main microphone alone.
 */
export function RecordingProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const { t } = useTranslation()
  const { capabilities, enqueueUpload, memory } = useTranscriptionWorkspace()
  const me = useQuery(meQuery).data
  const microphones = useMicrophones(
    memory.cell<string | null>('recording.microphone', () => DEFAULT_DEVICE_ID)
  )
  const stateCell = memory.cell<RecordingState>('recording.state', () => INITIAL_RECORDING_STATE)
  const [state, setState] = useMemoryCell(stateCell)
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
  const sourcesCell = memory.cell<SourcesState>('recording.sources', () => INITIAL_SOURCES)
  const [sources, setSources] = useMemoryCell(sourcesCell)
  const dispatchSources = useCallback(
    (action: SourcesAction) => setSources((current) => sourcesReducer(current, action)),
    [setSources]
  )
  const [sourceError, setSourceError] = useMemoryCell(
    memory.cell<string | null>('recording.sourceError', () => null)
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
  const [
    {
      session: sessionRef,
      stopping: stoppingRef,
      busy: busyRef,
      mounted: mountedRef,
      inputs,
      backupLocks,
      scanned: scannedRef,
      pendingDisplay: pendingDisplayRef,
      starting: startingRef,
      swap: swapRef,
      mainDevice: mainDeviceRef
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
           * The open sources of regular recording: the take's microphones while it runs, and the
           * shared tabs, windows and screens from their adding on.
           */
          inputs: new Map<string, Input>(),
          /**
           * The releases of the backups this page holds, by take: its takes', and an uploaded
           * take's until storage has it.
           */
          backupLocks: new Map<string, () => void>(),
          /** Whether the backup was searched for leftovers, once per page. */
          scanned: { current: false } as Box<boolean>,
          /** Gives up a tab, window or screen whose picker is still open. */
          pendingDisplay: { current: null } as Box<(() => void) | null>,
          /**
           * Gives up a take that is still starting, with what it holds outside `inputs`: the mixer,
           * the live session and its microphone, the recorder.
           */
          starting: { current: null } as Box<(() => void) | null>,
          /** Counts main microphone choices; only the latest one is mixed in. */
          swap: { current: 0 } as Box<number>,
          /**
           * The device of the running take's main microphone, `null` for none; a failed swap
           * selects it again.
           */
          mainDevice: { current: DEFAULT_DEVICE_ID } as Box<string | null>
        }
        // Leaving the page drops what runs without finishing it and frees every source. The
        // take's backup stays and is offered again on the next visit.
        memory.onDispose(() => {
          boxes.mounted.current = false
          boxes.pendingDisplay.current?.()
          boxes.pendingDisplay.current = null
          boxes.starting.current?.()
          boxes.starting.current = null
          const running = boxes.session.current
          boxes.session.current = null
          running?.realtime?.teardown()
          // The recorder's last chunk comes after its stop: the backup gets it before it closes,
          // and only then go the sources and the locks.
          const ended = Promise.all([running?.recorder.discard(), running?.tracks?.discard()])
          const pending = running ? ended.then(() => running.backup.journal.close()) : ended
          const held = [...boxes.inputs.values()]
          boxes.inputs.clear()
          const locks = [...boxes.backupLocks.values()]
          boxes.backupLocks.clear()
          void pending.finally(() => {
            running?.mixer?.close()
            releaseStream(running?.stream ?? null)
            for (const input of held) releaseStream(input.stream)
            for (const release of locks) release()
          })
          boxes.busy.current = false
        })
        return boxes
      }).value
  )

  const setTakes = useCallback((next: RecordedTake[]) => setTakesState(next), [setTakesState])

  const [displaySupport] = useState(detectDisplaySupport)
  const [backupFailed, setBackupFailed] = useMemoryCell(
    memory.cell('recording.backupFailed', () => false)
  )
  const [trackBackupFailed, setTrackBackupFailed] = useMemoryCell(
    memory.cell('recording.trackBackupFailed', () => false)
  )
  const [leftovers, setLeftovers] = useMemoryCell(
    memory.cell<StoredRecording[]>('recording.leftovers', () => [])
  )
  const [leftoverError, setLeftoverError] = useMemoryCell(
    memory.cell<string | null>('recording.leftoverError', () => null)
  )

  /** Lets go of a take's backup: another tab, or the next visit, may offer it. */
  const unlockBackup = useCallback(
    (id: string) => {
      backupLocks.get(id)?.()
      backupLocks.delete(id)
    },
    [backupLocks]
  )

  /**
   * Deletes a take's backup, once the take is deleted or its upload stored, and lets go of it. A
   * page left meanwhile let go already: it claims the backup again, unless another page took it
   * since.
   */
  const removeBackup = useCallback(
    async (id: string): Promise<void> => {
      const held = backupLocks.get(id)
      backupLocks.delete(id)
      const release = held ?? (await claimBackupLock(id))
      if (!release) return
      await removeStoredRecording(backupDirectory(), id)
      release()
    },
    [backupLocks]
  )

  /** Lists the backups no page holds and no take of this page uses. */
  const findLeftovers = useCallback(async (): Promise<void> => {
    const directory = await backupDirectory()
    if (!directory) return
    const skip = await heldBackupIds()
    for (const take of takesRef.current) if (take.backupId) skip.add(take.backupId)
    const running = sessionRef.current?.backup.id
    if (running) skip.add(running)
    const found: StoredRecording[] = []
    for (const listed of await listStoredRecordings(directory, skip)) {
      // Each one under its lock: another tab may have started or taken it since the query.
      const release = await claimBackupLock(listed.id)
      if (!release) continue
      try {
        const recording = await readStoredInfo(directory, listed.id)
        // Started but never got a chunk: nothing to offer.
        if (recording?.chunks === 0)
          await removeStoredRecording(Promise.resolve(directory), recording.id)
        else if (recording) found.push(recording)
      } finally {
        release()
      }
    }
    if (mountedRef.current) setLeftovers(found)
  }, [mountedRef, sessionRef, setLeftovers, takesRef])

  // Once per page.
  useEffect(() => {
    if (scannedRef.current) return
    scannedRef.current = true
    void findLeftovers()
  }, [findLeftovers, scannedRef])

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

  /** Lets an open source go: its track ends first, then its stream. */
  const releaseInput = useCallback(
    (stream: MediaStream) => {
      sessionRef.current?.tracks?.stop(stream)
      releaseStream(stream)
    },
    [sessionRef]
  )

  /** Releases the open sources of regular recording; the shared surfaces too unless `keep`. */
  const releaseInputs = useCallback(
    ({ keepDisplays }: { keepDisplays: boolean }) => {
      for (const [id, input] of inputs) {
        if (keepDisplays && input.kind === 'display') continue
        releaseInput(input.stream)
        inputs.delete(id)
      }
    },
    [inputs, releaseInput]
  )

  /** Ends the running recording; `lost` is the error that ended it from outside. */
  const finish = useCallback(
    (lost: string | null): Promise<void> => {
      if (stoppingRef.current) return stoppingRef.current
      const running = sessionRef.current
      if (!running) return Promise.resolve()
      const duration = (Date.now() - running.startedAt) / 1000
      // A main microphone still opening comes too late.
      swapRef.current++
      dispatch({ type: 'stop' })
      stoppingRef.current = (async () => {
        let error = lost
        let take: RecordedTake | null = null
        try {
          const recorded = running.recorder.stop()
          // Each source's track ends with the mix, before its stream is released.
          const tracked = running.tracks?.finish() ?? Promise.resolve([])
          // Live: the bridge finishes its transcripts while the recorder ends.
          const draining = running.realtime?.stop() ?? Promise.resolve()
          let blob: Blob | null = null
          try {
            blob = await recorded
          } catch {
            error ??= t('transcription.recording.stopRecordingFailed')
          }
          await draining
          // The backup gets its last chunks and stays until the take is uploaded or deleted.
          await running.backup.journal.close()
          const finished = await tracked
          if (blob) {
            const tracks = trackFiles(running.filename, running.fileType, finished)
            // One source at a time: the mix is all there is, its tracks' backups only repeat it.
            if (!tracks && running.tracks)
              await removeStoredTracks(backupDirectory(), running.backup.id)
            take = {
              id: crypto.randomUUID(),
              file: new File([blob], running.filename, { type: running.fileType }),
              duration,
              backupId: running.backup.id,
              tracks
            }
          }
        } finally {
          running.mixer?.close()
          releaseStream(running.stream)
          if (running.kind === 'record') {
            // Microphones open again with the next take; shared surfaces are let go.
            releaseInputs({ keepDisplays: false })
            dispatchSources({ type: 'takeEnded' })
          }
          if (sessionRef.current === running) sessionRef.current = null
        }
        // Without a take the backup is all there is: offered as a leftover.
        if (!take) unlockBackup(running.backup.id)
        if (!mountedRef.current) return
        if (!take) void findLeftovers()
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
      dispatchSources,
      findLeftovers,
      mountedRef,
      releaseInputs,
      sessionRef,
      setTakes,
      stoppingRef,
      swapRef,
      t,
      takesRef,
      unlockBackup
    ]
  )

  const stop = useCallback(() => finish(null), [finish])

  /** A microphone's name, as the card shows it. */
  const microphoneLabel = useCallback(
    (deviceId: string): string => {
      if (deviceId === DEFAULT_DEVICE_ID) return t('transcription.recording.defaultMicrophone')
      const choice = microphones.choices.find((entry) => entry.deviceId === deviceId)
      return choice?.label ?? t('transcription.recording.microphoneN', { n: choice?.number ?? 1 })
    },
    [microphones.choices, t]
  )

  // Track and connection events call the current callbacks, not the ones of their start; set
  // after each render, before any such event.
  const [latestRef] = useState(
    () =>
      memory.cell('recording.latest', () => ({
        current: null as {
          finish: (lost: string | null) => Promise<void>
          sourceEnded: (id: string, stream?: MediaStream) => void
          dropMain: (change: 'removed' | 'ended') => void
        } | null
      })).value
  )

  /** Keeps an open source of regular recording and hears when it ends by itself. */
  const holdInput = useCallback(
    (id: string, kind: SourceKind, stream: MediaStream) => {
      inputs.set(id, { stream, kind })
      for (const track of stream.getAudioTracks())
        track.addEventListener('ended', () => latestRef.current?.sourceEnded(id, stream), {
          once: true
        })
    },
    [inputs, latestRef]
  )

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
        // The chosen device is gone or busy: the next start tries the default input, which is
        // then no added source any more. Nothing was opened yet.
        if (name === 'NotFoundError' || name === 'OverconstrainedError') {
          microphones.select(DEFAULT_DEVICE_ID)
          dispatchSources({ type: 'mainSelected', deviceId: DEFAULT_DEVICE_ID })
        }
        fail(errorText(error) || t('transcription.recording.startRecordingFailed'))
      }
    },
    [dispatchSources, fail, microphones, t]
  )

  /** Why a microphone could not be opened. */
  const microphoneFailed = useCallback(
    (name: string, error: unknown): string =>
      t('transcription.recording.sources.microphoneFailed', {
        name,
        message: errorText(error) || errorName(error)
      }),
    [t]
  )

  /** An added microphone that could not be opened leaves the list, with the reason. */
  const dropMicrophone = useCallback(
    (source: RecordingSource, error: unknown) => {
      dispatchSources({ type: 'remove', id: source.id })
      setSourceError(microphoneFailed(source.label, error))
    },
    [dispatchSources, microphoneFailed, setSourceError]
  )

  /**
   * Opens the added microphones with the take. One that fails leaves the list and the take starts
   * without it. The sources may change meanwhile, e.g. a gone main microphone hands over to one
   * still opening: each outcome goes to whom the microphone belongs to by then.
   */
  const openAddedMicrophones = useCallback(
    async (devices: MediaDevices): Promise<void> => {
      const wanted = sourcesCell.value.list.filter(
        (source) => source.kind === 'microphone' && !inputs.has(source.id)
      )
      await Promise.all(
        wanted.map(async (source) => {
          const owner = (): 'source' | 'main' | null =>
            mountedRef.current
              ? startupMicrophoneOwner(
                  source,
                  sourcesCell.value.list,
                  microphones.latestSelected(),
                  inputs.has(MAIN_SOURCE_ID)
                )
              : null
          let stream: MediaStream
          try {
            stream = await devices.getUserMedia({
              audio: audioConstraint(source.deviceId ?? DEFAULT_DEVICE_ID)
            })
          } catch (error) {
            const failed = owner()
            if (failed === 'source') dropMicrophone(source, error)
            else if (failed === 'main') {
              // It took over the main microphone: it goes as the main one, removed with a reason.
              latestRef.current?.dropMain('removed')
              setSourceError(microphoneFailed(source.label, error))
            }
            return
          }
          const opened = owner()
          if (opened === 'source') holdInput(source.id, 'microphone', stream)
          else if (opened === 'main') {
            holdInput(MAIN_SOURCE_ID, 'microphone', stream)
            mainDeviceRef.current = source.deviceId
          } else releaseStream(stream)
        })
      )
    },
    [
      dropMicrophone,
      holdInput,
      inputs,
      latestRef,
      mainDeviceRef,
      microphoneFailed,
      microphones,
      mountedRef,
      setSourceError,
      sourcesCell
    ]
  )

  /**
   * Gives every source in the running mix its own track from now on; one that has one keeps it.
   * A microphone's track takes the device's own name where the browser gives one, as the default
   * input then names the device it is.
   */
  const trackMixed = useCallback(() => {
    const running = sessionRef.current
    if (!running?.tracks || !running.mixer) return
    for (const [id, input] of inputs) {
      if (!running.mixer.has(id)) continue
      const listed =
        id === MAIN_SOURCE_ID
          ? microphoneLabel(mainDeviceRef.current ?? DEFAULT_DEVICE_ID)
          : (sourcesCell.value.list.find((source) => source.id === id)?.label ??
            t('transcription.recording.sources.surface.other'))
      const device =
        input.kind === 'microphone' ? input.stream.getAudioTracks()[0]?.label.trim() : ''
      running.tracks.start(input.stream, device || listed, input.kind)
    }
  }, [inputs, mainDeviceRef, microphoneLabel, sessionRef, sourcesCell, t])

  /**
   * Records `stream` with its backup, named and typed after what the recorder writes, which it
   * says only once started. `release` undoes the start when the recorder cannot run. Regular
   * recording also records each source of its mix as a track, backed up with the take.
   */
  const startTake = useCallback(
    async (
      session: Pick<RunningSession, 'kind' | 'realtime' | 'mixer' | 'stream'>,
      recorded: MediaStream,
      release: () => void
    ): Promise<void> => {
      const id = crypto.randomUUID()
      const startedAt = Date.now()
      let journal: BackupJournal | null = null
      // Chunks before the journal is there wait for it.
      const early: Blob[] = []
      let recorder: LocalRecorder
      try {
        recorder = startLocalRecorder(recorded, {
          mimeType: recorderMimeType((type) => MediaRecorder.isTypeSupported(type)),
          audioBitsPerSecond: RECORDING_AUDIO_BITS_PER_SECOND,
          onChunk: (chunk) => (journal ? journal.add(chunk) : early.push(chunk))
        })
      } catch (error) {
        release()
        fail(errorText(error) || t('transcription.recording.startRecordingFailed'))
        return
      }
      startingRef.current = () => {
        void recorder.discard()
        release()
      }
      const type = await recorder.mimeType
      // Leaving the page dropped the recording.
      if (!mountedRef.current) return
      const format = recordingFormat(type)
      if (!format) {
        void recorder.discard()
        release()
        fail(
          type
            ? t('transcription.recording.formatUnsupported', { type })
            : t('transcription.recording.formatUnknown')
        )
        return
      }
      const filename = recordingFilename(
        recordingUsername(me ?? null),
        new Date(startedAt),
        format.extension
      )
      setBackupFailed(false)
      setTrackBackupFailed(false)
      // Granted before the first write, so no other tab offers or removes the backup while it
      // grows; the recorder's chunks wait in the journal meanwhile.
      const lock = holdBackupLock(id)
      backupLocks.set(id, lock.release)
      // The recording goes on without its backup; the record tab says so.
      const backupFailed = (): void => {
        if (mountedRef.current) setBackupFailed(true)
      }
      journal = createBackupJournal(
        lock.held.then(() => backupDirectory()),
        { id, startedAt, filename, mimeType: type },
        backupFailed
      )
      for (const chunk of early.splice(0)) journal.add(chunk)
      // A track records as the mix does; its backup failing fails neither it nor the take, and
      // the record tab says less than for the mix's.
      const trackBackupFailed = (): void => {
        if (mountedRef.current) setTrackBackupFailed(true)
      }
      const tracks = session.mixer
        ? new TakeTracks(startedAt, (stream, track) => {
            const meta = { ...track, mimeType: type }
            const trackJournal = createBackupJournal(
              trackDirectory(
                lock.held.then(() => backupDirectory()),
                id
              ),
              meta,
              trackBackupFailed
            )
            const trackRecorder = startLocalRecorder(stream, {
              mimeType: recorderMimeType((supported) => MediaRecorder.isTypeSupported(supported)),
              audioBitsPerSecond: RECORDING_AUDIO_BITS_PER_SECOND,
              onChunk: (chunk) => trackJournal.add(chunk)
            })
            return {
              recorder: trackRecorder,
              journal: { close: (endedAt) => trackJournal.close({ ...meta, endedAt }) }
            }
          })
        : null
      // Sources came, went or handed over while the take started: it mixes those open now.
      session.mixer?.sync(inputStreams(inputs))
      sessionRef.current = {
        ...session,
        recorder,
        startedAt,
        filename,
        fileType: format.type,
        backup: { id, journal },
        tracks
      }
      trackMixed()
      dispatch({ type: 'started', at: startedAt })
      // A source that ended while the recorder started may have been the last.
      if (session.mixer?.size === 0) void finish(null)
    },
    [
      backupLocks,
      dispatch,
      fail,
      finish,
      inputs,
      me,
      mountedRef,
      sessionRef,
      setBackupFailed,
      setTrackBackupFailed,
      startingRef,
      t,
      trackMixed
    ]
  )

  /** Regular recording: the main microphone and the added sources, mixed. */
  const startRecord = useCallback(
    async (devices: MediaDevices): Promise<void> => {
      let mixer: AudioMixer
      try {
        // Created in the click, so it runs without a resume.
        mixer = new AudioMixer(new AudioContext({ latencyHint: 'playback' }))
      } catch {
        fail(t('transcription.recording.errors.audioFailed'))
        return
      }
      // Leaving the page closes the mixer; the opened sources go with `inputs`.
      startingRef.current = () => mixer.close()
      // Without a main microphone the take starts with the other sources alone.
      const deviceId = microphones.latestSelected()
      if (deviceId !== null) {
        let main: MediaStream
        try {
          main = await devices.getUserMedia({ audio: audioConstraint(deviceId) })
        } catch (error) {
          mixer.close()
          if (mountedRef.current) failMicrophone(error)
          return
        }
        if (!mountedRef.current) {
          releaseStream(main)
          return
        }
        holdInput(MAIN_SOURCE_ID, 'microphone', main)
      }
      mainDeviceRef.current = deviceId
      await openAddedMicrophones(devices)
      if (!mountedRef.current) return
      if ([...inputs.values()].some((input) => input.kind === 'microphone'))
        microphones.markGranted()
      const release = (): void => {
        mixer.close()
        releaseInputs({ keepDisplays: true })
      }
      // Every added microphone failed and nothing else was there; the source error says why.
      if (inputs.size === 0) {
        release()
        fail(t('transcription.recording.startRecordingFailed'))
        return
      }
      try {
        mixer.sync(inputStreams(inputs))
        await mixer.run()
      } catch {
        release()
        fail(t('transcription.recording.errors.audioFailed'))
        return
      }
      if (!mountedRef.current) return
      await startTake(
        { kind: 'record', realtime: null, mixer, stream: null },
        mixer.stream,
        release
      )
    },
    [
      fail,
      failMicrophone,
      holdInput,
      inputs,
      mainDeviceRef,
      microphones,
      mountedRef,
      openAddedMicrophones,
      releaseInputs,
      startTake,
      startingRef,
      t
    ]
  )

  /**
   * Live transcription: the main microphone is sent and recorded alone, the default input when
   * regular recording left none.
   */
  const startLive = useCallback(
    async (devices: MediaDevices, liveMode: TranscriptionRealtimeMode): Promise<void> => {
      let stream: MediaStream
      try {
        stream = await devices.getUserMedia({
          audio: audioConstraint(microphones.latestSelected() ?? DEFAULT_DEVICE_ID)
        })
      } catch (error) {
        failMicrophone(error)
        return
      }
      if (!mountedRef.current) {
        releaseStream(stream)
        return
      }
      microphones.markGranted()

      dispatch({ type: 'connect' })
      // A new session starts with an empty transcript (T-61); the sample text does not return.
      resetText()
      setLiveStarted(true)
      setServiceError(null)
      const realtime: RealtimeSession = new RealtimeSession(
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
      const release = (): void => {
        realtime.teardown()
        releaseStream(stream)
      }
      // Leaving the page while connecting tears the session down.
      startingRef.current = release
      try {
        await realtime.start({ stream, mode: liveMode })
      } catch (error) {
        releaseStream(stream)
        if (mountedRef.current) fail(realtimeErrorText(error))
        return
      }
      if (!mountedRef.current) return
      await startTake({ kind: 'live', realtime, mixer: null, stream }, stream, release)
      // A lost connection leaves the take running without its realtime session.
      if (sessionRef.current?.stream !== stream) return
      // A microphone that disappears ends the take with what it recorded (T-55).
      for (const track of stream.getAudioTracks())
        track.addEventListener('ended', () => void latestRef.current?.finish(null), { once: true })
    },
    [
      dispatch,
      fail,
      failMicrophone,
      latestRef,
      microphones,
      mountedRef,
      realtimeErrorText,
      sessionRef,
      setServiceError,
      appendText,
      resetText,
      setLiveStarted,
      startTake,
      startingRef,
      t
    ]
  )

  const start = useCallback(
    async (kind: RecordingKind): Promise<void> => {
      if (busyRef.current) return
      busyRef.current = true
      dispatch({ type: 'request', kind })
      setSourceError(null)

      const devices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices
      if (!devices?.getUserMedia) {
        fail(t('transcription.recording.microphoneAccessUnsupported'))
        return
      }
      try {
        if (kind === 'record') await startRecord(devices)
        else if (mode) await startLive(devices, mode)
        else fail(t('transcription.recording.liveUnavailable'))
      } finally {
        // Started, failed or given up: what runs belongs to the session now.
        startingRef.current = null
      }
    },
    [busyRef, dispatch, fail, mode, setSourceError, startLive, startRecord, startingRef, t]
  )

  /**
   * Makes `stream` of `deviceId` the main microphone, in place in the running mix; without one, a
   * starting take mixes it once it runs.
   */
  const replaceMain = useCallback(
    (mixer: AudioMixer | null, deviceId: string, stream: MediaStream) => {
      const old = inputs.get(MAIN_SOURCE_ID)
      holdInput(MAIN_SOURCE_ID, 'microphone', stream)
      // The recorder goes on with the mix.
      mixer?.add(MAIN_SOURCE_ID, stream)
      mainDeviceRef.current = deviceId
      // A swapped microphone's track ends; the new one starts its own.
      if (old && old.stream !== stream) releaseInput(old.stream)
      trackMixed()
    },
    [holdInput, inputs, mainDeviceRef, releaseInput, trackMixed]
  )

  /**
   * Chooses the main microphone; a running regular recording swaps it in its mix. An added
   * microphone that is chosen keeps its open stream, also while a take starts or ends; another
   * device opens first, and the take goes on with the microphone it had until then.
   */
  const selectMicrophone = useCallback(
    (deviceId: string) => {
      if (deviceId === microphones.latestSelected()) return
      // Each choice outdates the swaps still opening.
      const swap = ++swapRef.current
      microphones.select(deviceId)
      setSourceError(null)
      const running = sessionRef.current
      const mixer = stateCell.value.status === 'recording' ? running?.mixer : null
      // An added microphone that becomes the main one is no added source any more.
      const added = sourcesCell.value.list.find(
        (source) => source.kind === 'microphone' && source.deviceId === deviceId
      )
      const promoted = added ? inputs.get(added.id) : undefined
      if (added) {
        inputs.delete(added.id)
        mixer?.remove(added.id)
      }
      dispatchSources({ type: 'mainSelected', deviceId })
      if (promoted) {
        replaceMain(mixer ?? null, deviceId, promoted.stream)
        return
      }
      if (!running || !mixer) return

      const devices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices
      if (!devices) return
      // A later choice, the take's end or leaving the page came first.
      const outdated = (): boolean =>
        swap !== swapRef.current || sessionRef.current !== running || !mountedRef.current
      devices.getUserMedia({ audio: audioConstraint(deviceId) }).then(
        (stream) => {
          if (outdated()) releaseStream(stream)
          else replaceMain(mixer, deviceId, stream)
        },
        (error: unknown) => {
          if (outdated()) return
          microphones.select(mainDeviceRef.current)
          setSourceError(microphoneFailed(microphoneLabel(deviceId), error))
          // Nothing left to record: the take ends as if stopped.
          if (mixer.size === 0) void finish(null)
        }
      )
    },
    [
      dispatchSources,
      finish,
      inputs,
      mainDeviceRef,
      microphoneFailed,
      microphoneLabel,
      microphones,
      mountedRef,
      replaceMain,
      sessionRef,
      setSourceError,
      sourcesCell,
      stateCell,
      swapRef
    ]
  )

  /**
   * The main microphone leaves, removed or gone: the first added microphone takes its place, with
   * its open stream while a take runs. Without one the take goes on with its tabs, windows and
   * screens, and ends as if stopped when nothing is left.
   */
  const dropMain = useCallback(
    (change: 'removed' | 'ended') => {
      const deviceId = microphones.latestSelected()
      if (deviceId === null) return
      const input = inputs.get(MAIN_SOURCE_ID)
      if (input) {
        releaseInput(input.stream)
        inputs.delete(MAIN_SOURCE_ID)
      }
      const running = sessionRef.current
      running?.mixer?.remove(MAIN_SOURCE_ID)
      // A failed swap to the successor leaves the take without a main microphone.
      mainDeviceRef.current = null
      dispatchSources({ type: 'mainChanged', change, label: microphoneLabel(deviceId) })
      const next = mainSuccessor(sourcesCell.value.list)
      if (next !== null) {
        selectMicrophone(next)
        return
      }
      // A main microphone still opening comes too late.
      swapRef.current++
      microphones.select(null)
      if (running?.mixer?.size === 0) void finish(null)
    },
    [
      dispatchSources,
      finish,
      inputs,
      mainDeviceRef,
      microphoneLabel,
      microphones,
      releaseInput,
      selectMicrophone,
      sessionRef,
      sourcesCell,
      swapRef
    ]
  )

  /**
   * A source went away by itself, or its device disappeared: it leaves the mix and the list.
   * `stream` ignores an event of a stream that was swapped or removed meanwhile. A take with no
   * source left ends as if stopped.
   */
  const sourceEnded = useCallback(
    (id: string, stream?: MediaStream) => {
      const input = inputs.get(id)
      if (stream && input?.stream !== stream) return
      if (id === MAIN_SOURCE_ID) {
        dropMain('ended')
        return
      }
      if (input) {
        releaseInput(input.stream)
        inputs.delete(id)
      }
      const running = sessionRef.current
      running?.mixer?.remove(id)
      dispatchSources({ type: 'ended', id })
      if (running?.mixer?.size === 0) void finish(null)
    },
    [dispatchSources, dropMain, finish, inputs, releaseInput, sessionRef]
  )

  useEffect(() => {
    latestRef.current = { finish, sourceEnded, dropMain }
  })

  /** Every source as the card lists it: the main microphone first, unless there is none. */
  const allSources = useMemo<RecordingSource[]>(() => {
    const main = microphones.selected
    if (main === null) return [...sources.list]
    return [
      { id: MAIN_SOURCE_ID, kind: 'microphone', deviceId: main, label: microphoneLabel(main) },
      ...sources.list
    ]
  }, [microphoneLabel, microphones.selected, sources.list])

  // A microphone whose device disappeared leaves the list, also between takes. The main one goes
  // last, so a gone added microphone does not take its place.
  useEffect(() => {
    if (microphones.list !== 'ready') return
    for (const source of goneMicrophones(allSources, microphones.choices).reverse())
      sourceEnded(source.id)
  }, [allSources, microphones.choices, microphones.list, sourceEnded])

  // Nothing left to record from, e.g. after a take let go of its shared tab: the browser's default
  // input stands in, as in kiChat.
  useEffect(() => {
    if (microphones.selected === null && sources.list.length === 0)
      microphones.select(DEFAULT_DEVICE_ID)
  }, [microphones, sources.list.length])

  const addMicrophone = useCallback(
    (deviceId: string) => {
      setSourceError(null)
      const label = microphoneLabel(deviceId)
      // Without a main microphone it becomes the main one, opened at once while a take runs.
      if (microphones.latestSelected() === null) {
        dispatchSources({ type: 'mainChanged', change: 'added', label })
        selectMicrophone(deviceId)
        return
      }
      const source: RecordingSource = {
        id: crypto.randomUUID(),
        kind: 'microphone',
        deviceId,
        label
      }
      dispatchSources({ type: 'add', source })
      // Before a take it opens with the take; while one runs, at once.
      const running = sessionRef.current
      const devices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices
      if (!running?.mixer || stateCell.value.status !== 'recording' || !devices) return
      const mixer = running.mixer
      devices.getUserMedia({ audio: audioConstraint(deviceId) }).then(
        (stream) => {
          const wanted = sourcesCell.value.list.some((entry) => entry.id === source.id)
          if (!wanted || sessionRef.current !== running || !mountedRef.current) {
            releaseStream(stream)
            return
          }
          holdInput(source.id, 'microphone', stream)
          mixer.add(source.id, stream)
          trackMixed()
        },
        (error: unknown) => {
          if (mountedRef.current) dropMicrophone(source, error)
        }
      )
    },
    [
      dispatchSources,
      dropMicrophone,
      holdInput,
      microphoneLabel,
      microphones,
      mountedRef,
      selectMicrophone,
      sessionRef,
      setSourceError,
      sourcesCell,
      stateCell,
      trackMixed
    ]
  )

  /** A shared surface's name: its own where the browser gives one, else what it is. */
  const displayName = useCallback(
    (display: DisplayAudio): string =>
      display.label ?? t(`transcription.recording.sources.surface.${display.surface ?? 'other'}`),
    [t]
  )

  const addDisplay = useCallback(() => {
    const devices = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices
    if (displaySupport !== 'supported' || !devices || pendingDisplayRef.current) return
    setSourceError(null)
    // Nothing may await before this: the picker needs the click (see `startDisplayCapture`).
    const starting = startDisplayCapture(devices)
    pendingDisplayRef.current = starting.cancel
    starting.capture
      .then(
        (display) => {
          const live = display.stream.getAudioTracks().some((track) => track.readyState === 'live')
          if (!mountedRef.current || !live) {
            releaseStream(display.stream)
            return
          }
          const source: RecordingSource = {
            id: crypto.randomUUID(),
            kind: 'display',
            deviceId: null,
            label: displayName(display)
          }
          // Held from now on, and mixed in at once while a take runs.
          holdInput(source.id, 'display', display.stream)
          dispatchSources({ type: 'add', source })
          if (stateCell.value.status === 'recording') {
            sessionRef.current?.mixer?.add(source.id, display.stream)
            trackMixed()
          }
        },
        (error: unknown) => {
          if (!mountedRef.current) return
          const failure = error instanceof DisplayCaptureError ? error.failure : 'failed'
          // Closing the picker is the user's choice, not an error.
          if (failure === 'noAudio')
            setSourceError(t('transcription.recording.sources.noDisplayAudio'))
          else if (failure === 'failed')
            setSourceError(
              t('transcription.recording.sources.displayFailed', {
                message: errorText(error instanceof DisplayCaptureError ? error.reason : error)
              })
            )
        }
      )
      .finally(() => {
        if (pendingDisplayRef.current === starting.cancel) pendingDisplayRef.current = null
      })
  }, [
    dispatchSources,
    displayName,
    displaySupport,
    holdInput,
    mountedRef,
    pendingDisplayRef,
    sessionRef,
    setSourceError,
    stateCell,
    t,
    trackMixed
  ])

  const removeSource = useCallback(
    (id: string) => {
      // One source always remains.
      if (!canRemoveSource(microphones.latestSelected(), sourcesCell.value.list)) return
      if (id === MAIN_SOURCE_ID) {
        dropMain('removed')
        return
      }
      const input = inputs.get(id)
      if (input) {
        releaseInput(input.stream)
        inputs.delete(id)
      }
      const running = sessionRef.current
      running?.mixer?.remove(id)
      dispatchSources({ type: 'remove', id })
      // The last source: the take ends as if stopped.
      if (running?.mixer?.size === 0) void finish(null)
    },
    [dispatchSources, dropMain, finish, inputs, microphones, releaseInput, sessionRef, sourcesCell]
  )

  const dismissAnnouncement = useCallback(
    () => dispatchSources({ type: 'dismiss' }),
    [dispatchSources]
  )

  const deleteTake = useCallback(
    (id: string) => {
      const backupId = takesRef.current.find((take) => take.id === id)?.backupId
      if (backupId) void removeBackup(backupId)
      const next = takesRef.current.filter((take) => take.id !== id)
      setTakes(next)
      dispatch({ type: 'takesChanged', takes: next.length })
    },
    [dispatch, removeBackup, setTakes, takesRef]
  )

  const uploadTakes = useCallback(() => {
    const taken = takesRef.current
    if (taken.length === 0 || busyRef.current) return
    // A take's backup stays, held by this page, until storage has its upload: a refused file, a
    // failed upload or leaving the page meanwhile does not lose it. The files are held weakly.
    const backups = new WeakMap<File, string>()
    for (const take of taken) if (take.backupId) backups.set(take.file, take.backupId)
    // Recorded WebM names no length of its own: the queue takes the running time.
    const durations = new Map<File, number>()
    for (const take of taken) if (take.duration) durations.set(take.file, take.duration)
    // Like kiChat, into the first group next to the files already there, through the same queue,
    // validation and analysis as picked files.
    enqueueUpload(
      taken.map((take) => take.file),
      {
        target: 'first',
        onStored: (file) => {
          const id = backups.get(file)
          if (id) void removeBackup(id)
        },
        durations
      }
    )
    setTakes([])
    dispatch({ type: 'takesChanged', takes: 0 })
  }, [busyRef, dispatch, enqueueUpload, removeBackup, setTakes, takesRef])

  const restoreLeftover = useCallback(
    async (id: string): Promise<void> => {
      const leftover = leftovers.find((entry) => entry.id === id)
      const directory = await backupDirectory()
      if (!leftover || !directory) return
      setLeftoverError(null)
      // Another tab may have taken it meanwhile.
      const release = await claimBackupLock(id)
      if (!release) {
        setLeftovers((current) => current.filter((entry) => entry.id !== id))
        return
      }
      const type = recordingFormat(leftover.mimeType)?.type ?? leftover.mimeType
      let file: File
      try {
        const blob = await readStoredRecording(directory, id)
        file = new File([blob], leftover.filename, { type })
      } catch {
        release()
        if (mountedRef.current) setLeftoverError(t('transcription.recording.backup.restoreFailed'))
        return
      }
      // Its tracks come back with it, those that read; a take backed up before tracks has none.
      const stored = await readStoredTracks(directory, id).catch(() => [])
      const tracks = trackFiles(
        leftover.filename,
        type,
        stored.map((track) => ({
          ...track,
          offset: trackOffset(leftover.startedAt, track.startedAt)
        }))
      )
      if (!mountedRef.current) {
        release()
        return
      }
      backupLocks.set(id, release)
      const take: RecordedTake = {
        id: crypto.randomUUID(),
        file,
        duration: leftover.duration ?? undefined,
        backupId: id,
        tracks
      }
      const next = [...takesRef.current, take]
      setTakes(next)
      setLeftovers((current) => current.filter((entry) => entry.id !== id))
      dispatch({ type: 'takesChanged', takes: next.length })
    },
    [
      backupLocks,
      dispatch,
      leftovers,
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
      const release = await claimBackupLock(id)
      if (release) {
        await removeStoredRecording(backupDirectory(), id)
        release()
      }
      if (mountedRef.current) setLeftovers((current) => current.filter((entry) => entry.id !== id))
    },
    [mountedRef, setLeftoverError, setLeftovers]
  )

  const backup = useMemo<RecordingBackup>(
    () => ({
      failed: backupFailed,
      tracksFailed: trackBackupFailed,
      leftovers,
      restore: restoreLeftover,
      discard: discardLeftover,
      leftoverError
    }),
    [backupFailed, trackBackupFailed, leftovers, restoreLeftover, discardLeftover, leftoverError]
  )

  const option = useCallback(
    (deviceId: string): MicrophoneOption => ({ deviceId, label: microphoneLabel(deviceId) }),
    [microphoneLabel]
  )
  const addable = useMemo(
    () => addableMicrophones(microphones.choices, microphones.selected, sources.list).map(option),
    [microphones.choices, microphones.selected, option, sources.list]
  )
  const liveMicrophone = useMemo<LiveMicrophone>(() => {
    const current = microphones.selected ?? DEFAULT_DEVICE_ID
    return {
      current: option(current),
      others: addableMicrophones(microphones.choices, current, []).map(option)
    }
  }, [microphones.choices, microphones.selected, option])
  const recordingSources = useMemo<RecordingSources>(
    () => ({
      list: allSources,
      removable: canRemoveSource(microphones.selected, sources.list),
      announcement: sources.announcement,
      dismissAnnouncement,
      error: sourceError,
      displaySupport,
      addableMicrophones: addable,
      addMicrophone,
      addDisplay,
      remove: removeSource
    }),
    [
      allSources,
      microphones.selected,
      sources,
      dismissAnnouncement,
      sourceError,
      displaySupport,
      addable,
      addMicrophone,
      addDisplay,
      removeSource
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
    resetText()
    setServiceError(null)
  }, [resetText, setServiceError])

  const recording = useMemo<Recording>(
    () => ({
      state,
      microphones,
      selectMicrophone,
      sources: recordingSources,
      liveMicrophone,
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
      },
      backup
    }),
    [
      state,
      microphones,
      selectMicrophone,
      recordingSources,
      liveMicrophone,
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
      resetAppearance,
      backup
    ]
  )

  return (
    <RecordingContext.Provider value={recording}>
      <WidgetTargetReceiver />
      {children}
    </RecordingContext.Provider>
  )
}
