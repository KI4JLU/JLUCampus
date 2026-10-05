import { failing, readForm, SEGMENT_SECONDS, wavDuration } from './asr.mjs'
import { sendJson } from './http.mjs'

/**
 * Speaker diarisation in the contract of kiChat's Speaches server, below `/diarization/v1`:
 *
 * - `POST /audio/diarization`: multipart `file`, `model`, `num_speakers` or `min_speakers`, and
 *   per known voice `known_speaker_names[i]` and `known_speaker_references[i]` (a base64 WAV data
 *   URI). Answers `{ "segments": [{ "start", "end", "speaker" }] }` in seconds.
 * - `POST /audio/speech/timestamps`: multipart `file` and `model` (`silero_vad_v5`). Answers the
 *   speech regions as `[{ "start", "end" }]` in milliseconds.
 *
 * Deterministic: the voices take turns in blocks of two of the speech mock's segments (eight
 * seconds), so every recognised segment lies within one turn. Under eight seconds one voice
 * speaks, from eight seconds two, from 48 seconds three; `num_speakers=1` gives one voice and
 * `min_speakers=2` at least two (a short file is split in half). The voices are `SPEAKER_00`,
 * `SPEAKER_01`, … as pyannote names them. A known voice is recognised by finding its reference's
 * samples in the file (references are cut from the same normalised audio): the voice speaking
 * there answers under the reference's name. A file that is no WAV answers 415 as kiChat's
 * diariser did; the model `mock-fail` and `TRANSCRIPTION_MOCK_FAIL=diarization` answer 503 (the
 * VAD too), and a request without the key `TRANSCRIPTION_MOCK_DIARIZATION_KEY`, if set, answers
 * 403 `Invalid API key` as the HRZ diariser does.
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {string} path the path below `/diarization`, e.g. `/v1/audio/diarization`
 * @returns {Promise<boolean>} whether the request was handled
 */
export async function handle(request, response, path) {
  const diarization = path === '/v1/audio/diarization'
  const timestamps = path === '/v1/audio/speech/timestamps'
  if (request.method !== 'POST' || (!diarization && !timestamps)) return false
  const key = process.env.TRANSCRIPTION_MOCK_DIARIZATION_KEY
  if (key && request.headers.authorization !== `Bearer ${key}`) {
    sendJson(response, 403, { detail: 'Invalid API key' })
    return true
  }
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
  const bytes = Buffer.from(await file.arrayBuffer())
  const duration = wavDuration(bytes)
  if (duration === null) {
    sendJson(response, 415, { error: { message: 'Unsupported audio: expected a WAV file' } })
    return true
  }
  if (timestamps) {
    sendJson(
      response,
      200,
      diarize(duration).map((turn) => ({
        start: Math.round(turn.start * 1000),
        end: Math.round(turn.end * 1000)
      }))
    )
    return true
  }
  const hint =
    form.get('num_speakers') === '1' ? 'single' : form.get('min_speakers') ? 'multi' : 'auto'
  const turns = diarize(duration, hint)
  sendJson(response, 200, { segments: nameKnown(turns, knownSpeakers(form), bytes) })
  return true
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
      speaker: `SPEAKER_${String(voices === 1 ? 0 : index % voices).padStart(2, '0')}`
    })
  }
  return segments.filter((segment) => segment.end > segment.start)
}

/** The known voices of the form: `known_speaker_names[i]` with `known_speaker_references[i]`. */
export function knownSpeakers(form) {
  const known = []
  for (let index = 0; form.has(`known_speaker_names[${index}]`); index++) {
    const name = form.get(`known_speaker_names[${index}]`)
    const reference = form.get(`known_speaker_references[${index}]`)
    if (typeof name === 'string' && typeof reference === 'string') known.push({ name, reference })
  }
  return known
}

/** The PCM samples of a WAV and their bytes per second, or `null`. */
function pcmOf(bytes) {
  for (let offset = 12, byteRate = 0; offset + 8 <= bytes.length;) {
    const id = bytes.toString('ascii', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    const start = offset + 8
    if (id === 'fmt ') byteRate = bytes.readUInt32LE(start + 8)
    if (id === 'data') {
      return byteRate ? { data: bytes.subarray(start, start + size), byteRate } : null
    }
    offset = start + size + (size % 2)
  }
  return null
}

/**
 * Renames the voice speaking where a reference's audio lies in the file to the reference's name,
 * as an identifying diariser answers known voices.
 */
export function nameKnown(turns, known, bytes) {
  const file = pcmOf(bytes)
  if (!file || known.length === 0) return turns
  const names = new Map()
  for (const { name, reference } of known) {
    const match = /^data:audio\/[\w.+-]+;base64,(.*)$/s.exec(reference)
    const clip = match ? pcmOf(Buffer.from(match[1], 'base64')) : null
    if (!clip || clip.data.length < 64) continue
    // A tenth of a second is unique enough in recorded (or noise) audio.
    const probe = clip.data.subarray(0, Math.min(clip.data.length, file.byteRate / 10))
    const at = file.data.indexOf(probe)
    if (at < 0) continue
    const seconds = at / file.byteRate
    const turn = turns.find(
      (candidate) => seconds >= candidate.start - 0.1 && seconds < candidate.end
    )
    if (turn && !names.has(turn.speaker)) names.set(turn.speaker, name)
  }
  return turns.map((turn) => ({ ...turn, speaker: names.get(turn.speaker) ?? turn.speaker }))
}
