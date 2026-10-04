const cleanups = new Set<() => void>()

/**
 * Runs `cleanup` after every successful sign-out (`signOut` in `session.ts`), for what a module
 * keeps in this browser for the signed-in user (drafts, caches in `localStorage`), so a shared
 * device shows nothing of theirs to the next person. Returns a function that unregisters it.
 */
export function onSignOut(cleanup: () => void): () => void {
  cleanups.add(cleanup)
  return () => cleanups.delete(cleanup)
}

/** Runs the registered cleanups; one that fails does not keep the others from running. */
export function runSignOutCleanups(): void {
  for (const cleanup of cleanups) {
    try {
      cleanup()
    } catch {
      // The next cleanup still runs.
    }
  }
}
