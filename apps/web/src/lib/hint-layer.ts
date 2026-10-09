import { useSyncExternalStore } from 'react'

function subscribeToBodyStyle(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(document.body, { attributes: true, attributeFilter: ['style'] })
  return () => observer.disconnect()
}

/**
 * Whether a modal layer is open: a dialog, a menu or a select list. Radix makes the rest of the
 * page unclickable meanwhile (`pointer-events: none` on `<body>`), which is also what tells. A
 * hint's own dialog counts too, so ask before it opens.
 */
export function useModalLayerOpen(): boolean {
  return useSyncExternalStore(
    subscribeToBodyStyle,
    () => document.body.style.pointerEvents === 'none'
  )
}

const HINT_ATTRIBUTE = 'data-announcement-hint'

/** Marks a hint's dialog, so other pop-ups can tell a click into it from a click away. */
export const hintMarker = { [HINT_ATTRIBUTE]: '' } as const

/** Whether `target` lies in a hint's dialog. */
export function isInAnnouncementHint(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${HINT_ATTRIBUTE}]`) !== null
}
