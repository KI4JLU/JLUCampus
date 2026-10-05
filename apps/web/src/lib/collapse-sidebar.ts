import { createContext, useContext, useLayoutEffect } from 'react'

/**
 * Folds the navigation column until the returned function lets go of it (see
 * `useCollapsedSidebar`).
 */
export const CollapseSidebarContext = createContext<() => () => void>(() => () => {})

/**
 * Folds the navigation column while the page is shown, for pages that need the room, e.g. an
 * embedded site with navigation of its own. The user can open it again; once the page is gone the
 * column is as the user last left it elsewhere. Below `lg` the shell has no column to fold.
 *
 * Tied to the page's lifetime rather than the path: the router still shows the old page while the
 * next one loads.
 */
export function useCollapsedSidebar(): void {
  const hold = useContext(CollapseSidebarContext)
  // Before paint, so the column does not flash open on the way in.
  useLayoutEffect(() => hold(), [hold])
}
