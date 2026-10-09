import { useCallback, useSyncExternalStore } from 'react'

const WATCHED_ATTRIBUTES = ['class', 'style', 'hidden', 'open', 'data-state', 'aria-hidden']

/**
 * Re-checks on every change to the page's elements or their visibility, and on resizes (a
 * column folds, a breakpoint hides an element). The browser batches mutations per task.
 */
function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange)
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: WATCHED_ATTRIBUTES
  })
  window.addEventListener('resize', onChange)
  return () => {
    observer.disconnect()
    window.removeEventListener('resize', onChange)
  }
}

/** Whether the element takes up room on screen: rendered, not `hidden`, not `display: none`. */
function isVisible(element: Element): boolean {
  if (element.getClientRects().length === 0) return false
  const box = element.getBoundingClientRect()
  if (box.width === 0 && box.height === 0) return false
  return element.checkVisibility?.({ visibilityProperty: true, opacityProperty: true }) ?? true
}

/** The first element matching `selector` that is visible; an invalid selector finds nothing. */
export function findVisible(selector: string): Element | null {
  try {
    for (const element of document.querySelectorAll(selector)) {
      if (isVisible(element)) return element
    }
  } catch {
    /* Not CSS: the admin page warns about it, users just never see the hint. */
  }
  return null
}

export interface VisibleTarget {
  /** Which selector found it. */
  index: number
  element: Element
}

/**
 * The element of the first selector that has one visible on the page, kept up to date as the
 * page renders (elements may appear late, e.g. after a query), changes or hides it.
 */
export function useVisibleTarget(selectors: readonly string[]): VisibleTarget | null {
  // A new array with the same selectors keeps the snapshot function.
  const key = JSON.stringify(selectors)
  const getElement = useCallback((): Element | null => {
    for (const selector of JSON.parse(key) as string[]) {
      const element = findVisible(selector)
      if (element) return element
    }
    return null
  }, [key])
  // The element itself is the snapshot: it stays the same object while nothing changed.
  const element = useSyncExternalStore(subscribe, getElement)
  if (!element) return null
  const index = selectors.findIndex((selector) => matches(element, selector))
  return index === -1 ? null : { index, element }
}

function matches(element: Element, selector: string): boolean {
  try {
    return element.matches(selector)
  } catch {
    return false
  }
}
