/**
 * Schemas the contract's modules share. They live apart from `index.ts` so a module's own file
 * (such as `transcription.ts`) can use them while `index.ts` re-exports that file.
 */
import { z } from 'zod'

/** `https:` anywhere, `http:` only for loopback hosts in development. */
export const httpsUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .url()
  .refine(
    (value) => {
      // Zod 4 still runs refinements after `.url()` failed, so parsing must not throw.
      let url: URL
      try {
        url = new URL(value)
      } catch {
        return false
      }
      if (url.protocol === 'https:') return true
      return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    },
    { message: 'URL must use https (http is only allowed for localhost)' }
  )

/** Longest value of one component secret, such as an API key. */
export const SECRET_VALUE_MAX = 4096
