import { createContext, useContext } from 'react'

/**
 * Opens the news dialog with every news item, for reading them again. `opener` gets the focus
 * back when the dialog closes, e.g. the account menu's button when the menu item is gone by then.
 */
export const OpenNewsContext = createContext<(opener: HTMLElement | null) => void>(() => {})

export function useOpenNews(): (opener: HTMLElement | null) => void {
  return useContext(OpenNewsContext)
}
