import { app, BrowserWindow, ipcMain, protocol, session, shell, systemPreferences } from 'electron'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { is } from '@electron-toolkit/utils'
import {
  DESKTOP_LINK_SCHEME,
  desktopLinkPath,
  isAppPath,
  type DesktopModuleId
} from '@justcampus/shared'
import { initializeLanguage, onLanguageChange, setLanguage, t } from './i18n'
import { allowPermissionCheck, allowPermissionRequest } from './media-permissions'
import { modules } from './modules'
import type { DesktopMainModule } from './modules/types'
import { resolveStaticFile } from './static'
import { DesktopStore } from './store'

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
  }
])

const hasInstanceLock = app.requestSingleInstanceLock()
if (!hasInstanceLock) app.quit()

let mainWindow: BrowserWindow | null = null
let quitting = false
let pendingLink = process.argv.map(desktopLinkPath).find((path) => path !== null) ?? null
let showWhenReady = false
const store = new DesktopStore()

function origin(value: string): string {
  return new URL(value).origin
}

const apiOrigin = origin(
  process.env.JUSTCAMPUS_API_URL ?? import.meta.env.MAIN_VITE_API_URL ?? 'http://localhost:3000'
)
/** The API's WebSocket origin (live transcription): `ws:`/`wss:` for `http:`/`https:`. */
const apiSocketOrigin = apiOrigin.replace(/^http/, 'ws')
const keycloakOrigin = origin(process.env.JUSTCAMPUS_KEYCLOAK_ORIGIN ?? 'http://localhost:8080')
/**
 * Origins besides the API the renderer fetches from and plays media of: the transcription
 * module's object storage (signed upload and playback URLs). Space or comma separated;
 * `JUSTCAMPUS_CONNECT_ORIGINS` at runtime, else the build's `DESKTOP_CONNECT_ORIGINS`.
 */
const connectOrigins = (
  process.env.JUSTCAMPUS_CONNECT_ORIGINS ??
  import.meta.env.MAIN_VITE_CONNECT_ORIGINS ??
  'http://localhost:9100'
)
  .split(/[\s,]+/)
  .flatMap((value) => {
    try {
      return value ? [origin(value)] : []
    } catch {
      return []
    }
  })
  .join(' ')
const developmentUrl = process.env.JUSTCAMPUS_WEB_DEV_URL ?? 'http://localhost:5173'
const rendererDirectory = resolve(__dirname, '../renderer')

function isRendererUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      (url.protocol === 'app:' && url.host === '-') ||
      (is.dev && url.origin === origin(developmentUrl))
    )
  } catch {
    return false
  }
}

function trustedSender(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
  const window = mainWindow
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  )
    return false
  return isRendererUrl(event.senderFrame.url)
}

function isAllowedNavigation(url: string): boolean {
  try {
    const target = new URL(url)
    return (
      (target.protocol === 'app:' && target.host === '-') ||
      (is.dev && target.origin === origin(developmentUrl)) ||
      target.origin === apiOrigin ||
      target.origin === keycloakOrigin
    )
  } catch {
    return false
  }
}

/**
 * macOS asks once per app before any process may record; Chromium's own prompt does not cover it.
 * Resolves with whether the microphone may be used.
 */
async function systemMicrophoneAccess(): Promise<boolean> {
  if (process.platform !== 'darwin') return true
  const status = systemPreferences.getMediaAccessStatus('microphone')
  if (status === 'granted') return true
  if (status !== 'not-determined') return false
  return systemPreferences.askForMediaAccess('microphone')
}

function configureSession(): void {
  // The renderer may record audio (transcription) and show the live transcript in fullscreen;
  // everything else, and anything an embedded site asks for, stays refused.
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    const allowed =
      contents === mainWindow?.webContents &&
      allowPermissionRequest(
        {
          permission,
          url: details.requestingUrl,
          isMainFrame: details.isMainFrame,
          mediaTypes: 'mediaTypes' in details ? details.mediaTypes : undefined
        },
        isRendererUrl
      )
    if (!allowed || permission !== 'media') return callback(allowed)
    systemMicrophoneAccess().then(callback, () => callback(false))
  })
  session.defaultSession.setPermissionCheckHandler((contents, permission, origin, details) =>
    Boolean(
      contents &&
      contents === mainWindow?.webContents &&
      allowPermissionCheck(
        {
          permission,
          url: details.requestingUrl ?? origin,
          isMainFrame: details.isMainFrame,
          mediaType: details.mediaType
        },
        isRendererUrl
      )
    )
  )
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (new URL(details.url).protocol !== 'app:')
      return callback({ responseHeaders: details.responseHeaders })

    const responseHeaders = { ...details.responseHeaders }
    responseHeaders['Content-Security-Policy'] = [
      `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' ${apiOrigin} ${apiSocketOrigin} ${connectOrigins}; media-src 'self' blob: data: ${apiOrigin} ${connectOrigins}; frame-src https: http://localhost:*; object-src 'none'; base-uri 'none'`
    ]
    callback({ responseHeaders })
  })
}

function openExternalUrl(value: string): Promise<void> {
  let target: URL
  try {
    target = new URL(value)
  } catch {
    return Promise.reject(new Error('A valid HTTP(S) URL is required'))
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return Promise.reject(new Error('A valid HTTP(S) URL is required'))
  }
  return shell.openExternal(target.toString())
}

function handleNavigation(window: BrowserWindow, event: Electron.Event, url: string): void {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    event.preventDefault()
    return
  }

  if (target.protocol === 'app:' && target.host === '-') {
    event.preventDefault()
    void window.loadURL(url)
  } else if (!isAllowedNavigation(url)) {
    event.preventDefault()
    void openExternalUrl(url).catch(() => {})
  }
}

function showWindow(): void {
  if (!mainWindow) createWindow()
  if (!mainWindow) return
  mainWindow.show()
  mainWindow.focus()
}

function navigate(path: string): void {
  if (!isAppPath(path)) throw new Error('Invalid app path')
  showWindow()
  const contents = mainWindow?.webContents
  if (!contents) return
  if (contents.isLoading() || !isRendererUrl(contents.getURL())) {
    pendingLink = path
    if (!contents.isLoading()) void mainWindow?.loadURL(is.dev ? developmentUrl : 'app://-/')
    return
  }
  contents.send('justcampus:navigate', path)
}

function receiveLink(args: string[]): void {
  const path = args.map(desktopLinkPath).find((value) => value !== null)
  if (!mainWindow) {
    if (path) pendingLink = path
    showWhenReady = true
    return
  }
  if (path) navigate(path)
  else showWindow()
}

app.on('second-instance', (_event, argv) => receiveLink(argv))
app.on('open-url', (event, url) => {
  event.preventDefault()
  receiveLink([url])
})
app.on('before-quit', () => {
  quitting = true
})

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--justcampus-api-url=${apiOrigin}`]
    }
  })
  mainWindow = window
  window.once('ready-to-show', () => {
    if (
      showWhenReady ||
      !(process.argv.includes('--autostart') && store.get().notifications.closeToTray)
    )
      window.show()
  })
  window.on('close', (event) => {
    if (quitting || !store.get().notifications.closeToTray) return
    event.preventDefault()
    window.hide()
  })
  window.on('closed', () => {
    mainWindow = null
  })
  window.webContents.on('did-finish-load', () => {
    if (pendingLink) {
      const path = pendingLink
      pendingLink = null
      navigate(path)
    }
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalUrl(url).catch(() => {})
    return { action: 'deny' }
  })
  // Also fired for redirects inside an embedded site's iframe; those stay in the iframe.
  window.webContents.on('will-redirect', (event, url) => {
    if (event.isMainFrame) handleNavigation(window, event, url)
  })
  window.webContents.on('will-navigate', (event, url) => handleNavigation(window, event, url))

  if (is.dev) void window.loadURL(developmentUrl)
  else void window.loadURL('app://-/')
}

app.whenReady().then(async () => {
  if (!hasInstanceLock) return
  initializeLanguage()
  await store.load()
  protocol.handle('app', async (request) => {
    const url = new URL(request.url)
    if (url.host !== '-') return new Response('Not found', { status: 404 })

    const file = resolveStaticFile(rendererDirectory, url.pathname)
    if (!file) return new Response('Not found', { status: 404 })
    return new Response(await readFile(file.path), { headers: { 'content-type': file.mimeType } })
  })
  configureSession()
  ipcMain.handle('justcampus:open-external', (event, url: unknown) => {
    if (!trustedSender(event)) throw new Error('Untrusted renderer')
    if (typeof url !== 'string') throw new Error('A valid HTTP(S) URL is required')
    return openExternalUrl(url)
  })
  ipcMain.on('justcampus:set-language', (event, language: unknown) => {
    if (trustedSender(event)) setLanguage(language)
  })
  // Development builds register only on Windows, where the handler names the script to run;
  // elsewhere they would make the bare Electron binary the system's handler for the scheme.
  if (app.isPackaged) app.setAsDefaultProtocolClient(DESKTOP_LINK_SCHEME)
  else if (process.platform === 'win32')
    app.setAsDefaultProtocolClient(DESKTOP_LINK_SCHEME, process.execPath, [
      resolve(process.argv[1])
    ])
  // Windows shows notifications only for an app with an AppUserModelId (the installer's appId).
  if (process.platform === 'win32') app.setAppUserModelId('de.uni-giessen.campus')
  createWindow()
  for (const module of Object.values(modules) as DesktopMainModule<DesktopModuleId>[]) {
    const id = module.id
    module.setup({
      id,
      store,
      window: () => mainWindow,
      showWindow,
      navigate,
      t,
      onLanguageChange,
      handle(method, fn) {
        ipcMain.handle(`justcampus:${id}:${method}`, (event, ...args: unknown[]) => {
          if (!trustedSender(event)) throw new Error('Untrusted renderer')
          return fn(...args)
        })
      }
    })
  }
  app.on('activate', showWindow)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
