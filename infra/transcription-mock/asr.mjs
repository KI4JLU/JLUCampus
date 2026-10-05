import { readBody, sendJson } from './http.mjs'

/**
 * OpenAI-compatible speech recognition, below `/asr/v1`: `GET /models` and
 * `POST /audio/transcriptions` (multipart `file`, `model`, optional `language`,
 * `response_format=verbose_json`, `timestamp_granularities[]`) answering Whisper-style
 * `verbose_json` with segments.
 *
 * Nothing is recognised: the answer depends only on the WAV's length (read from its header) and
 * the language. Every four seconds of audio give one segment with the next sentence of a fixed
 * script, German unless `language=en`; the German script says "zehn Uhr", which the chat mock's
 * correction turns into "10 Uhr" as kiChat's did. Words (with Whisper's leading space) come back
 * too when `timestamp_granularities[]=word` is asked for, as kiChat asks and Speaches answers;
 * the model `mock-gateway` answers as the HRZ gateway does, without words and with the duration
 * as a string. A file that is no WAV answers 415, the model `mock-fail` answers 503, and
 * `TRANSCRIPTION_MOCK_FAIL=asr` makes every request answer 503.
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {string} path the path below `/asr`, e.g. `/v1/models`
 * @returns {Promise<boolean>} whether the request was handled
 */
export async function handle(request, response, path) {
  if (request.method === 'GET' && path === '/v1/models') {
    sendJson(response, 200, {
      object: 'list',
      data: [
        { id: 'jlu/whisper-1', object: 'model' },
        { id: 'mock-gateway', object: 'model' },
        { id: 'mock-fail', object: 'model' }
      ]
    })
    return true
  }
  if (request.method === 'POST' && path === '/v1/audio/transcriptions') {
    const form = await readForm(request)
    const file = form?.get('file')
    if (!form || !(file instanceof Blob)) {
      sendJson(response, 400, { error: { message: 'Send the audio as multipart field "file"' } })
      return true
    }
    if (form.get('model') === 'mock-fail' || failing('asr')) {
      sendJson(response, 503, { error: { message: 'The mock recognition fails on purpose' } })
      return true
    }
    const duration = wavDuration(Buffer.from(await file.arrayBuffer()))
    if (duration === null) {
      sendJson(response, 415, { error: { message: 'Unsupported audio: expected a WAV file' } })
      return true
    }
    const language = form.get('language') === 'en' ? 'en' : 'de'
    if (form.get('model') === 'mock-gateway') {
      sendJson(response, 200, asGateway(recognize(duration, language)))
      return true
    }
    const words = form.getAll('timestamp_granularities[]').includes('word')
    sendJson(response, 200, recognize(duration, language, words))
    return true
  }
  return false
}

/** Whether `TRANSCRIPTION_MOCK_FAIL` (comma-separated) names this upstream. */
export function failing(name) {
  return (process.env.TRANSCRIPTION_MOCK_FAIL ?? '')
    .split(',')
    .map((value) => value.trim())
    .includes(name)
}

/** The multipart body as `FormData`, or `undefined` when it is none. */
export async function readForm(request) {
  const body = await readBody(request)
  try {
    return await new Request('http://mock/', {
      method: 'POST',
      headers: { 'Content-Type': request.headers['content-type'] ?? '' },
      body
    }).formData()
  } catch {
    return undefined
  }
}

/**
 * Seconds of audio in a WAV file from its `fmt ` and `data` chunks, or `null` when the bytes are
 * no WAV. A data size ffmpeg left open (streamed output) counts as the rest of the file.
 */
export function wavDuration(bytes) {
  if (bytes.length < 12) return null
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    return null
  }
  let byteRate = 0
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = bytes.toString('ascii', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    const start = offset + 8
    if (id === 'fmt ' && start + 16 <= bytes.length) byteRate = bytes.readUInt32LE(start + 8)
    if (id === 'data') {
      if (!byteRate) return null
      const available = bytes.length - start
      return Math.min(size, available) / byteRate
    }
    offset = start + size + (size % 2)
  }
  return null
}

const SCRIPTS = {
  de: [
    'Guten Tag und herzlich willkommen.',
    'Dies ist ein kurzer Test der Transkription für die Universität Gießen.',
    'Wir treffen uns am Montag um zehn Uhr.',
    'Bitte bringen Sie die Unterlagen mit.',
    'Gibt es dazu noch Fragen?',
    'Ja, wer schreibt das Protokoll?',
    'Das übernehme ich gerne.',
    'Vielen Dank.'
  ],
  en: [
    'Good morning and welcome.',
    'This is a short test of the transcription for the University of Giessen.',
    'We will meet on Monday at ten o clock.',
    'Please bring the documents with you.',
    'Are there any questions?',
    'Yes, who takes the minutes?',
    'I will gladly do that.',
    'Thank you very much.'
  ]
}

/** Seconds of audio one segment covers. */
export const SEGMENT_SECONDS = 4

const round = (value) => Math.round(value * 1000) / 1000

/** The `verbose_json` for `duration` seconds of audio. */
export function recognize(duration, language, withWords = false) {
  const script = SCRIPTS[language]
  const segments = []
  for (let start = 0; duration - start >= 0.5; start += SEGMENT_SECONDS) {
    const index = segments.length
    const end = Math.min(duration, start + SEGMENT_SECONDS)
    const text = script[index % script.length]
    segments.push({
      id: index + 1,
      seek: Math.round(start * 100),
      start: round(start),
      end: round(end),
      text: ` ${text}`,
      tokens: [...text].slice(0, 12).map((character) => 50_000 + character.charCodeAt(0)),
      temperature: 0,
      avg_logprob: -0.05 - index * 0.001,
      compression_ratio: 0.98,
      no_speech_prob: 0.01
    })
  }
  const result = {
    task: 'transcribe',
    language,
    duration: round(duration),
    text: segments.map((segment) => segment.text.trim()).join(' '),
    segments
  }
  if (withWords) {
    result.words = segments.flatMap((segment) => {
      const parts = segment.text.trim().split(/\s+/)
      // Speech ends a little before the segment does: a pause between sentences.
      const pause = Math.min(0.3, (segment.end - segment.start) / 4)
      const step = (segment.end - pause - segment.start) / parts.length
      // Whisper's words carry their leading space, as Speaches answers them.
      return parts.map((word, position) => ({
        word: ` ${word}`,
        start: round(segment.start + position * step),
        end: round(segment.start + (position + 1) * step),
        probability: 0.95
      }))
    })
  }
  return result
}

/**
 * An answer as the HRZ gateway (vLLM behind LiteLLM) gives it: no word timing (`words: null`)
 * whatever was asked for, the duration as a string and no usage.
 */
export function asGateway(result) {
  return { ...result, duration: String(result.duration), words: null, usage: null }
}
