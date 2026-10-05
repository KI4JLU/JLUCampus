import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** The repository's `.env.example`, as operators copy it. */
const example = readFileSync(join(__dirname, '../../../../.env.example'), 'utf8')

describe('the desktop part of .env.example', () => {
  it('lists no OpenAI origin for the CSP: live transcription runs over the API (W-11)', () => {
    const section = example.slice(example.indexOf('# ---- Desktop (apps/desktop) ----'))
    const lines = section.split('\n').filter((line) => line.includes('DESKTOP_CONNECT_ORIGINS'))
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(line).not.toMatch(/openai/i)
    expect(section).not.toMatch(/api\.openai\.com|OpenAI Realtime/)
  })
})
