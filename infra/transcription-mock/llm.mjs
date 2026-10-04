import { readJson, sendJson } from './http.mjs'

/**
 * OpenAI-compatible chat completions, below `/llm/v1`: `GET /models` and `POST /chat/completions`
 * for text correction, subtitles, speaker optimisation, summaries and section previews.
 *
 * Answers are deterministic and derived from the request only: the task is recognised by its
 * system prompt, and the answer has the JSON shape the server's prompt asks for. The model
 * `mock-fail` answers 500, `mock-prose` answers plain prose instead of JSON (to exercise the
 * server's lenient parsing).
 *
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {string} path the path below `/llm`, e.g. `/v1/chat/completions`
 * @returns {Promise<boolean>} whether the request was handled
 */
export async function handle(request, response, path) {
  if (request.method === 'GET' && path === '/v1/models') {
    sendJson(response, 200, {
      object: 'list',
      data: [
        { id: 'mock-chat', object: 'model', name: 'Mock Chat' },
        { id: 'mock-chat-large', object: 'model' },
        { id: 'mock-embedding', object: 'model' },
        { id: 'mock-whisper', object: 'model' }
      ]
    })
    return true
  }
  if (request.method === 'POST' && path === '/v1/chat/completions') {
    const body = await readJson(request)
    const messages = Array.isArray(body?.messages) ? body.messages : []
    const model = typeof body?.model === 'string' ? body.model : 'mock-chat'
    if (model === 'mock-fail') {
      sendJson(response, 500, { error: { message: 'The mock model fails on purpose' } })
      return true
    }
    const system = messages.find((message) => message?.role === 'system')?.content ?? ''
    const user = messages.findLast((message) => message?.role === 'user')?.content ?? ''
    const content =
      model === 'mock-prose' ? prose(String(user)) : answer(String(system), String(user))
    sendJson(response, 200, {
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      created: 0,
      model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    })
    return true
  }
  return false
}

/** The content of the answer to a task, as the server's prompts ask for it. */
export function answer(system, user) {
  if (system.includes('speech recognition') || isStringArray(parse(user))) {
    return JSON.stringify({ text: correct(parse(user)) })
  }
  if (system.includes('Sprecherzuordnung')) return JSON.stringify(reassign(parse(user)))
  if (system.includes('Unterzeile')) return JSON.stringify(metadata(system, user))
  if (system.includes('Ergebnisdokument'))
    return JSON.stringify({ markdown: section(system, user) })
  const parsed = parse(user)
  return JSON.stringify(parsed === undefined ? { text: user } : parsed)
}

function parse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** The correction: numbers in digits where kiChat's fixture had them, nothing else. */
function correct(texts) {
  if (!isStringArray(texts)) return []
  return texts.map((text) => text.replace(/\bzehn Uhr\b/g, '10 Uhr'))
}

/** `Name: text` lines of a transcript as `[name, text]`. */
function turns(transcript) {
  return transcript
    .replace(/^Transkript:\n/, '')
    .split('\n')
    .map((line) => /^([^:\n]{1,100}):\s?(.*)$/.exec(line))
    .filter(Boolean)
    .map((match) => [match[1].trim(), match[2].trim()])
}

function speakersOf(transcript) {
  return [...new Set(turns(transcript).map(([name]) => name))]
}

function firstWords(transcript, count) {
  const text = turns(transcript)
    .map(([, words]) => words)
    .join(' ')
  const words = text.split(/\s+/).filter(Boolean)
  return words
    .slice(0, count)
    .join(' ')
    .replace(/[.,;:!?]+$/, '')
}

function metadata(system, user) {
  const speakers = speakersOf(user)
  const subject = firstWords(user, 6) || 'eine Aufnahme'
  const result = {
    subtitle: `Gespräch mit ${speakers.join(', ') || 'unbekannten Personen'} über „${subject}“`
  }
  if (system.includes('"title"')) result.title = `Gespräch: ${firstWords(user, 4) || 'Aufnahme'}`
  return result
}

/** A section's content: how many turns, by whom, and the first one quoted. */
function section(system, user) {
  const heading = /Abschnitt "([^"]*)"/.exec(system)?.[1] ?? ''
  const all = turns(user)
  const speakers = speakersOf(user)
  const first = all[0] ? `„${all[0][1].slice(0, 120)}“ (${all[0][0]})` : 'kein Text'
  const lines = [
    `- ${all.length} Redebeiträge von ${speakers.join(', ') || 'niemandem'}.`,
    `- Erster Beitrag: ${first}`
  ]
  if (heading) return lines.join('\n')
  return ['## Zusammenfassung', '', ...lines, '', '## Beschlüsse', '', '- Keine erkennbar.'].join(
    '\n'
  )
}

/**
 * The speaker optimisation: a segment without speaker gets its predecessor's (else the first
 * speaker's), all others stay. Answers one entry per segment.
 */
function reassign(input) {
  const speakers = Array.isArray(input?.speakers) ? input.speakers : []
  const segments = Array.isArray(input?.segments) ? input.segments : []
  let previous = speakers[0] ?? null
  return {
    segments: segments.map((segment) => {
      const speaker = segment.speaker ?? previous
      previous = speaker
      return { id: segment.id, speaker }
    })
  }
}

/** What `mock-prose` says: no JSON, just text. */
function prose(user) {
  return `Hier ist meine Antwort.\n\nDas Gespräch beginnt mit: ${firstWords(user, 5) || 'nichts'}.`
}
