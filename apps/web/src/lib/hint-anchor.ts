import { useEffect, useEffectEvent, useSyncExternalStore } from 'react'
import { isRendered, WATCHED_ATTRIBUTES } from './use-visible-target'

/**
 * Calls `onLeave` once `element` leaves the page, stops being rendered or leaves the viewport
 * (scrolled away, or clipped by a scrolling container). `null` watches nothing.
 */
export function useAnchorLeaves(element: Element | null, onLeave: () => void): void {
  const leave = useEffectEvent(onLeave)
  useEffect(() => {
    if (!element) return
    let left = false
    const check = (onScreen: boolean): void => {
      if (left) return
      if (onScreen && element.isConnected && isRendered(element)) return
      left = true
      leave()
    }
    let onScreen = true
    const intersections = new IntersectionObserver((entries) => {
      const entry = entries.at(-1)
      if (entry) onScreen = entry.isIntersecting && entry.intersectionRatio > 0
      check(onScreen)
    })
    intersections.observe(element)
    const mutations = new MutationObserver(() => check(onScreen))
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: WATCHED_ATTRIBUTES
    })
    return () => {
      intersections.disconnect()
      mutations.disconnect()
    }
  }, [element])
}

/**
 * The element on screen that `selector` finds, if any. A hint uses it to follow its element when
 * the app renders a new one in its place (the sidebar does so when "More apps" opens).
 */
export function renderedMatch(selector: string): Element | null {
  let elements: Element[]
  try {
    elements = [...document.querySelectorAll(selector)]
  } catch {
    return null
  }
  return (
    elements.find((element) => {
      if (!isRendered(element)) return false
      const box = element.getBoundingClientRect()
      return box.bottom > 0 && box.right > 0 && box.top < innerHeight && box.left < innerWidth
    }) ?? null
  )
}

function subscribeToBodyStyle(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(document.body, { attributes: true, attributeFilter: ['style'] })
  return () => observer.disconnect()
}

/**
 * Whether a modal layer is open: a dialog, a menu or a select list. Radix makes the rest of the
 * page unclickable meanwhile (`pointer-events: none` on `<body>`), which is also what tells.
 */
export function useModalLayerOpen(): boolean {
  return useSyncExternalStore(
    subscribeToBodyStyle,
    () => document.body.style.pointerEvents === 'none'
  )
}

const HINT_ATTRIBUTE = 'data-announcement-hint'

/** Marks a hint's pop-up, so other pop-ups can tell a click into it from a click away. */
export const hintMarker = { [HINT_ATTRIBUTE]: '' } as const

/** Whether `target` lies in a hint's pop-up. */
export function isInAnnouncementHint(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${HINT_ATTRIBUTE}]`) !== null
}
