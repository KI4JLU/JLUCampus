import { failing, readForm, SEGMENT_SECONDS, wavDuration } from './asr.mjs'
import { sendJson } from './http.mjs'

/**
 * Speaker diarisation, below `/diarization`: `POST /diarize` takes audio (multipart `file`, plus
 * the server's hints `num_speakers` or `min_speakers` and an optional `model`) and answers
 * `{ "segments": [{ "start", "end", "speaker" }] }` in seconds, the format the server's
 * diarisation adapter reads.
 *
 * Deterministic: the voices take turns in blocks of two of the speech mock's segments (eight
 * seconds), so every recognised segment lies within one turn. Under eight seconds one voice
 * speaks, from eight seconds two, from 48 seconds three; `num_speakers=1` gives one voice and
 * `min_speakers=2` at least two (a short file is split in half). The voices are called `spk_a`,
 * `spk_b`, … as a diariser of its own would; the server renames them. A file that is no WAV
 * answers 415 as kiChat's diarisation did, the model `mock-fail` and `TRANSCRIPTION_MOCK_FAIL=
 * diarization` answer 503.
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {string} path the path below `/diarization`, e.g. `/diarize`
 * @returns {Promise<boolean>} whether the request was handled
 */
export async function handle(request, response, path) {
  if (request.method === 'POST' && path === '/diarize') {
    const form = await readForm(request)
    const file = form?.get('file')
    if (!form || !(file instanceof Blob)) {
      sendJson(response, 400, { error: { message: 'Send the audio as multipart field "file"' } })
      return true
    }
    if (form.get('model') === 'mock-fail' || failing('diarization')) {
      sendJson(response, 503, { error: { message: 'The mock diarisation fails on purpose' } })
      return true
    }
    const duration = wavDuration(Buffer.from(await file.arrayBuffer()))
    if (duration === null) {
      sendJson(response, 415, { error: { message: 'Unsupported audio: expected a WAV file' } })
      return true
    }
    const hint =
      form.get('num_speakers') === '1' ? 'single' : form.get('min_speakers') ? 'multi' : 'auto'
    sendJson(response, 200, { segments: diarize(duration, hint) })
    return true
  }
  return false
}

/** Seconds one voice speaks before the next takes over. */
export const TURN_SECONDS = 2 * SEGMENT_SECONDS

const round = (value) => Math.round(value * 1000) / 1000

/** The turns for `duration` seconds of audio and a speaker-count hint. */
export function diarize(duration, hint = 'auto') {
  if (!(duration > 0)) return []
  let voices = duration < TURN_SECONDS ? 1 : duration < 48 ? 2 : 3
  if (hint === 'single') voices = 1
  if (hint === 'multi') voices = Math.max(2, voices)
  const turn = voices > 1 && duration < voices * TURN_SECONDS ? duration / voices : TURN_SECONDS
  const segments = []
  for (let start = 0, index = 0; start < duration; start += turn, index++) {
    const end = Math.min(duration, start + turn)
    // A short pause before the next voice, as real turns have.
    const speechEnd = end < duration ? Math.max(start + 0.1, end - 0.1) : end
    segments.push({
      start: round(start + (start > 0 ? 0.05 : 0.03)),
      end: round(speechEnd),
      speaker: `spk_${String.fromCharCode(97 + (voices === 1 ? 0 : index % voices))}`
    })
  }
  return segments.filter((segment) => segment.end > segment.start)
}
