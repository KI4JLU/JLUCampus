import { readJson, sendJson } from './http.mjs'

/**
 * OpenAI-compatible chat completions, below `/llm/v1`: `GET /models` and `POST /chat/completions`
 * for text correction, titles, subtitles, speaker optimisation, summaries and section previews.
 * For automated tests and offline development only; the module runs against the HRZ gateway.
 *
 * Answers are deterministic and derived from the request only: the task is recognised by the
 * system prompt the server sends (kiChat's prompts), and the answer has the shape that prompt asks
 * for. The model `mock-fail` answers 500, `mock-prose` answers plain prose (to exercise the
 * server's lenient parsing), `mock-think` (not listed) puts a `<think>` block before its answer and the
 * thinking into `reasoning_content` as Qwen3 behind vLLM does.
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
    const text = model === 'mock-prose' ? prose(String(user)) : answer(String(system), String(user))
    const thinking = 'Ich lese die Anfrage und überlege, was verlangt ist.'
    const message =
      model === 'mock-think'
        ? {
            role: 'assistant',
            content: `<think>${thinking}</think>\n\n${text}`,
            reasoning_content: thinking
          }
        : { role: 'assistant', content: text }
    sendJson(response, 200, {
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      created: 0,
      model,
      choices: [{ index: 0, message, finish_reason: 'stop' }],
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
  if (system.includes('Sprecherzuordnungen')) return JSON.stringify(reassign(user))
  if (system.includes('Titel zuweist') || system.includes('three-word title')) return title(user)
  if (system.includes('Unterzeile')) return subtitle(user)
  if (system.includes('Transkripte präzise')) return summary(user)
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

/** The text after a label line such as `TRANSKRIPT:`, else all of it. */
function after(user, label) {
  const index = user.indexOf(`${label}\n`)
  return index < 0 ? user : user.slice(index + label.length + 1)
}

/** The first three words of the text, as the name prompt asks. */
function title(user) {
  return (
    user
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 3)
      .join(' ')
      .replace(/[.,;:!?]+$/, '') || 'Aufnahme'
  )
}

function subtitle(user) {
  const transcript = after(user, 'TRANSKRIPT-ANFANG:')
  const speakers = speakersOf(transcript)
  return `Gespräch von ${speakers.join(', ') || 'unbekannten Personen'}: ${firstWords(transcript, 6) || 'eine Aufnahme'}`
}

/**
 * A section's content: how many turns, by whom, and the first one quoted. An instruction asking
 * for a whole protocol (the standard template) gets a document with its own headings.
 */
function summary(user) {
  const instruction = user.split('\n\nTRANSKRIPT:\n')[0] ?? ''
  const transcript = after(user, 'TRANSKRIPT:')
  const all = turns(transcript)
  const speakers = speakersOf(transcript)
  const first = all[0] ? `„${all[0][1].slice(0, 120)}“ (${all[0][0]})` : 'kein Text'
  const lines = [
    `- ${all.length} Redebeiträge von ${speakers.join(', ') || 'niemandem'}.`,
    `- Erster Beitrag: ${first}`
  ]
  if (!instruction.includes('Ergebnisprotokoll')) return lines.join('\n')
  return ['## Zusammenfassung', '', ...lines, '', '## Beschlüsse', '', '- Keine erkennbar.'].join(
    '\n'
  )
}

/**
 * The speaker optimisation as kiChat's prompt asks: one entry per `Segment [X] (Name): text`
 * line. A segment of `Unbekannt` gets its predecessor's speaker (else the first named one), all
 * others stay, texts unchanged.
 */
function reassign(user) {
  const segments = [...user.matchAll(/^Segment \[(\d+)\] \(([^)\n]*)\): ?(.*)$/gm)].map(
    (match) => ({ index: Number(match[1]), speaker: match[2], text: match[3] })
  )
  const named = segments.map((segment) => segment.speaker).filter((name) => name !== 'Unbekannt')
  let previous = named[0] ?? 'Unbekannt'
  return segments.map((segment) => {
    const speaker = segment.speaker === 'Unbekannt' ? previous : segment.speaker
    previous = speaker
    return { original_index: segment.index, text: segment.text, speaker }
  })
}

/** What `mock-prose` says: no JSON, just text. */
function prose(user) {
  return `Hier ist meine Antwort.\n\nDas Gespräch beginnt mit: ${firstWords(user, 5) || 'nichts'}.`
}
