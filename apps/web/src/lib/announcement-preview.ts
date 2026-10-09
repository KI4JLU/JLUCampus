import { useMemo, useSyncExternalStore } from 'react'
import { parsePreview, serializePreview, type AnnouncementPreview } from './announcements'
import { onSignOut } from './sign-out-cleanups'

const STORAGE_KEY = 'justcampus.announcement-preview'

const listeners = new Set<() => void>()

function read(): string | null {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function write(preview: AnnouncementPreview | null): void {
  try {
    if (preview) window.sessionStorage.setItem(STORAGE_KEY, serializePreview(preview))
    else window.sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    /* Without storage the preview ends with the page; nothing else depends on it. */
  }
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * The hint the admin is trying out, kept in the tab's session storage so it survives navigating
 * and reloading, but not the tab.
 */
export function useAnnouncementPreview(): AnnouncementPreview | null {
  const raw = useSyncExternalStore(subscribe, read)
  return useMemo(() => parsePreview(raw), [raw])
}

/** The stored preview as it is now, for an editor's first render. */
export function readAnnouncementPreview(): AnnouncementPreview | null {
  return parsePreview(read())
}

export function startAnnouncementPreview(preview: Omit<AnnouncementPreview, 'active'>): void {
  write({ ...preview, active: true })
}

/** Hides the hint; its form waits for the editor to take it back. */
export function endAnnouncementPreview(): void {
  const preview = readAnnouncementPreview()
  if (preview?.active) write({ ...preview, active: false })
}

/** Forgets the preview and its form, once the editor has them back or they are not the user's. */
export function clearAnnouncementPreview(): void {
  if (read() !== null) write(null)
}

// The unsaved text must not wait in the tab for the next person to sign in.
onSignOut(clearAnnouncementPreview)
