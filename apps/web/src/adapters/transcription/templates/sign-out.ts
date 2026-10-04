import { queryClient, queryKeys } from '@/lib/queries'
import { clearPreviewCaches } from './preview-cache'

let watching = false

/**
 * Clears the template previews in `localStorage` when the user signs out. Sign-out empties the
 * query cache (`signOut` in `lib/session.ts`), which removes the signed-in user's `me` query; it is
 * observed for as long as someone is signed in, so nothing else removes it.
 */
export function clearPreviewsOnSignOut(): void {
  if (watching || typeof window === 'undefined') return
  watching = true
  queryClient.getQueryCache().subscribe((event) => {
    if (event.type === 'removed' && event.query.queryKey[0] === queryKeys.me[0]) {
      clearPreviewCaches(window.localStorage)
    }
  })
}
