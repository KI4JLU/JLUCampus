import { useMemo, useSyncExternalStore } from 'react'

/** Attributes whose change may show or hide an element. */
export const WATCHED_ATTRIBUTES = ['class', 'style', 'hidden', 'open', 'data-state', 'aria-hidden']

export interface VisibleTarget {
  /** Which selector found it. */
  index: number
  element: Element
}

/**
 * The first group, in order, with an eligible item, and that item. Groups are the elements each
 * selector finds; a group without an eligible one (none on the page, or none on screen) passes
 * the turn to the next.
 */
export function firstEligible<T>(
  groups: readonly (readonly T[])[],
  isEligible: (item: T) => boolean
): { index: number; item: T } | null {
  for (const [index, group] of groups.entries()) {
    const item = group.find(isEligible)
    if (item !== undefined) return { index, item }
  }
  return null
}

/** The elements `selector` finds; an invalid selector finds nothing. */
function queryAll(selector: string): Element[] {
  try {
    return [...document.querySelectorAll(selector)]
  } catch {
    // Not CSS: the admin page warns about it, users just never see the hint.
    return []
  }
}

/** Whether the element is rendered with a size: not `hidden`, `display: none` or invisible. */
export function isRendered(element: Element): boolean {
  const box = element.getBoundingClientRect()
  if (box.width === 0 && box.height === 0) return false
  return element.checkVisibility?.({ visibilityProperty: true, opacityProperty: true }) ?? true
}

interface TargetWatcher {
  subscribe: (onChange: () => void) => () => void
  getSnapshot: () => VisibleTarget | null
}

/**
 * Watches the elements the selectors find: which are on the page (a `MutationObserver`, so late
 * renders count) and which intersect the viewport, unclipped by scrolling containers (an
 * `IntersectionObserver`, which reports as the user scrolls or the layout moves). The snapshot is
 * the first selector's element that is both.
 */
function createTargetWatcher(selectors: readonly string[]): TargetWatcher {
  let snapshot: VisibleTarget | null = null
  const onScreen = new Set<Element>()
  const listeners = new Set<() => void>()
  let stop: (() => void) | null = null

  const start = (): (() => void) => {
    const observed = new Set<Element>()
    const intersections = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && entry.intersectionRatio > 0) onScreen.add(entry.target)
        else onScreen.delete(entry.target)
      }
      evaluate()
    })

    const evaluate = (): void => {
      const groups = selectors.map(queryAll)
      const found = new Set(groups.flat())
      for (const element of found) {
        if (!observed.has(element)) {
          observed.add(element)
          intersections.observe(element)
        }
      }
      for (const element of observed) {
        if (!found.has(element)) {
          observed.delete(element)
          onScreen.delete(element)
          intersections.unobserve(element)
        }
      }
      const next = firstEligible(groups, (element) => onScreen.has(element) && isRendered(element))
      if (next?.item === snapshot?.element && next?.index === snapshot?.index) return
      snapshot = next ? { index: next.index, element: next.item } : null
      listeners.forEach((listener) => listener())
    }

    const mutations = new MutationObserver(evaluate)
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: WATCHED_ATTRIBUTES
    })
    window.addEventListener('resize', evaluate)
    evaluate()
    return () => {
      mutations.disconnect()
      intersections.disconnect()
      window.removeEventListener('resize', evaluate)
      onScreen.clear()
      snapshot = null
    }
  }

  return {
    subscribe: (onChange) => {
      listeners.add(onChange)
      stop ??= start()
      return () => {
        listeners.delete(onChange)
        if (listeners.size === 0) {
          stop?.()
          stop = null
        }
      }
    },
    getSnapshot: () => snapshot
  }
}

/**
 * The element of the first selector that has one on screen, kept up to date as the page renders
 * (elements may appear late, e.g. after a query), changes, scrolls or hides it. The preview uses
 * it to tell the admin when a page has no element to click.
 */
export function useVisibleTarget(selectors: readonly string[]): VisibleTarget | null {
  // A new array with the same selectors keeps the watcher.
  const key = JSON.stringify(selectors)
  const watcher = useMemo(() => createTargetWatcher(JSON.parse(key) as string[]), [key])
  return useSyncExternalStore(watcher.subscribe, watcher.getSnapshot)
}
