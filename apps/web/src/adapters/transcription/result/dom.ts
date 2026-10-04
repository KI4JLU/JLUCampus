/** The element id of a speaker block, for scrolling to it from the player and the panel. */
export function blockElementId(index: number): string {
  return `transcription-block-${index}`
}

/**
 * Scrolls a speaker block into the middle of the view, smoothly unless reduced motion is asked
 * for. `onlyIfHidden` leaves a block that is already fully visible where it is.
 */
export function scrollToBlock(index: number, onlyIfHidden = false): void {
  const element = document.getElementById(blockElementId(index))
  if (!element) return
  if (onlyIfHidden) {
    const rect = element.getBoundingClientRect()
    if (rect.top >= 0 && rect.bottom <= window.innerHeight) return
  }
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  element.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' })
}
