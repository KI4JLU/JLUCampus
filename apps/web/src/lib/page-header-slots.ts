import { createContext, type ReactNode } from 'react'

/**
 * Actions the route adds after a page's own in its `PageHeader`, e.g. "copy desktop link" on
 * component pages in the desktop app.
 */
export const PageHeaderExtraActionsContext = createContext<ReactNode>(null)
