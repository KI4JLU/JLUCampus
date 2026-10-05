/** Small helpers the mock's modules share. */

/** The request body as a Buffer. */
export async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks)
}

/** The request body parsed as JSON, or `undefined` when it is none. */
export async function readJson(request) {
  const body = await readBody(request)
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    return undefined
  }
}

export function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

export function sendText(response, status, text, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(status, { 'Content-Type': contentType })
  response.end(text)
}

/** What a mock endpoint answers until its module implements it. */
export function notImplemented(response, what) {
  sendJson(response, 501, { error: { message: `${what} is not implemented in the mock yet` } })
}
