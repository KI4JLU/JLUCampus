import { loadModuleRuntime } from '../../runtime.js'
import { transcriptionConfigSchema } from '../config.js'
import { deleteTranscripts, staleTranscriptIds } from './store.js'

/** How often the sweep looks for transcripts past the retention period. */
const SWEEP_INTERVAL_MS = 15 * 60_000
/** Transcripts one round deletes at most; the next round takes the rest. */
const SWEEP_BATCH = 200

/**
 * Deletes saved transcripts last changed longer than `transcriptRetentionHours` ago, with their
 * summaries, and lets their jobs expire, so the job sweep removes the audio. Runs for a disabled
 * module too: switching it off must not keep data longer than promised. Returns how many it deleted.
 */
export async function sweepTranscripts(now: Date = new Date()): Promise<number> {
  const runtime = await loadModuleRuntime('transcription', transcriptionConfigSchema, false)
  const hours = runtime?.config.transcriptRetentionHours ?? null
  if (!runtime || hours === null) return 0
  const cutoff = new Date(now.getTime() - hours * 3_600_000)
  let deleted = 0
  for (;;) {
    const ids = await staleTranscriptIds(runtime.componentId, cutoff, SWEEP_BATCH)
    if (ids.length === 0) break
    const count = await deleteTranscripts(runtime.componentId, null, ids)
    deleted += count
    if (ids.length < SWEEP_BATCH || count === 0) break
  }
  return deleted
}

/**
 * Starts the sweep that deletes saved transcripts past the admin's `transcriptRetentionHours`
 * (none while it is `null`). Returns the function that stops it.
 */
export function startTranscriptRetention(): () => void {
  let busy = false
  let stopped = false
  async function tick(): Promise<void> {
    if (busy || stopped) return
    busy = true
    try {
      const deleted = await sweepTranscripts()
      if (deleted > 0) console.log(`Transcription retention deleted ${deleted} transcripts`)
    } catch (error) {
      console.error('Transcription retention sweep failed', error)
    } finally {
      busy = false
    }
  }
  const timer = setInterval(() => {
    void tick()
  }, SWEEP_INTERVAL_MS)
  void tick()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
