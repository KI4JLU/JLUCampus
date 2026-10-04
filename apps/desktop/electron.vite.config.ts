import { resolve } from 'node:path'
import { defineConfig, loadEnv } from 'electron-vite'

export default defineConfig(({ mode }) => {
  // electron-vite only exposes MAIN_VITE_* by default. Map the repository's
  // DESKTOP_API_URL into that namespace so it is baked into the main bundle.
  const env = loadEnv(mode, resolve(import.meta.dirname, '../..'), ['DESKTOP_'])

  return {
    main: {
      define: {
        'import.meta.env.MAIN_VITE_API_URL': JSON.stringify(
          env.DESKTOP_API_URL ?? 'http://localhost:3000'
        ),
        // Storage and realtime origins the renderer may reach besides the API (see main's CSP).
        'import.meta.env.MAIN_VITE_CONNECT_ORIGINS': JSON.stringify(
          env.DESKTOP_CONNECT_ORIGINS ?? 'http://localhost:9100 https://api.openai.com'
        )
      }
    },
    preload: {}
  }
})
