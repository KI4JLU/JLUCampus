import { onSignOut } from '@/lib/sign-out-cleanups'
import { clearLocalHistories } from './history/local-store'
import { clearPreviewCaches } from './templates/preview-cache'

let registered = false

/**
 * Makes sign-out take what the module keeps in this browser for the signed-in user: the local
 * history with transcripts only this browser has, and the template editor's AI previews. Called
 * once, when the app loads the adapter.
 */
export function clearOnSignOut(): void {
  if (registered || typeof window === 'undefined') return
  registered = true
  onSignOut(() => {
    clearLocalHistories()
    clearPreviewCaches(window.localStorage)
  })
}
