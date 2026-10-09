let replaying = false

/** Whether the events on their way come from `replayClick`, not from the user. */
export function isReplaying(): boolean {
  return replaying
}

/**
 * Plays a click on `element` again after a hint held it back: press, release and click, as a mouse
 * would send them, so actions on the press (Radix menus and lists) run as well as those on the click.
 */
export function replayClick(element: Element): void {
  if (!element.isConnected) return
  const mouse = { bubbles: true, cancelable: true, composed: true, button: 0, view: window }
  const pointer = { ...mouse, pointerId: 1, pointerType: 'mouse', isPrimary: true }
  replaying = true
  try {
    element.dispatchEvent(new PointerEvent('pointerdown', pointer))
    element.dispatchEvent(new MouseEvent('mousedown', mouse))
    element.dispatchEvent(new PointerEvent('pointerup', pointer))
    element.dispatchEvent(new MouseEvent('mouseup', mouse))
    if (element instanceof HTMLElement) element.click()
    else element.dispatchEvent(new MouseEvent('click', mouse))
  } finally {
    replaying = false
  }
}

const HINT_ATTRIBUTE = 'data-announcement-hint'

/** Marks a hint's dialog, so other pop-ups can tell a click into it from a click away. */
export const hintMarker = { [HINT_ATTRIBUTE]: '' } as const

/** Whether `target` lies in a hint's dialog. */
export function isInAnnouncementHint(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${HINT_ATTRIBUTE}]`) !== null
}
