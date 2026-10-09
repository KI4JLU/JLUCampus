/** Where a control of the page sits relative to the element a hint points at. */
export type AnchorRelation = 'before' | 'self' | 'inside' | 'after'

/**
 * Whether Tab leaves the hint rather than moving within it: forward from its last control,
 * backward from its first (or from the hint itself). `controls` are the hint's, in order.
 */
export function leavesHint<T>(controls: readonly T[], focused: T, backwards: boolean): boolean {
  const index = controls.indexOf(focused)
  if (backwards) return index <= 0
  return controls.length === 0 || index === controls.length - 1
}

/**
 * The page's control that takes the focus from the hint, which sits right after its element in
 * reading order: going on, the first control after the element; going back (or closing the hint),
 * the element itself when it takes focus, else the last control before or in it. `null` when the
 * page has none there.
 */
export function pageControlBeside<T>(
  controls: readonly T[],
  relation: (control: T) => AnchorRelation,
  backwards: boolean
): T | null {
  if (!backwards) return controls.find((control) => relation(control) === 'after') ?? null
  const self = controls.find((control) => relation(control) === 'self')
  if (self !== undefined) return self
  return controls.filter((control) => relation(control) !== 'after').at(-1) ?? null
}

const TABBABLE = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'summary',
  '[tabindex]',
  '[contenteditable="true"]'
].join(',')

/** The elements under `root` that Tab reaches, in document order, leaving out `exclude`'s. */
export function tabbablesIn(root: ParentNode, exclude: Element | null = null): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.matches(':disabled') &&
      element.closest('[inert]') === null &&
      element.getClientRects().length > 0 &&
      !exclude?.contains(element)
  )
}

/** Where `control` sits relative to `anchor` in the document. */
export function relationTo(anchor: Element): (control: Element) => AnchorRelation {
  return (control) => {
    if (control === anchor) return 'self'
    if (anchor.contains(control)) return 'inside'
    const position = anchor.compareDocumentPosition(control)
    return position & Node.DOCUMENT_POSITION_FOLLOWING ? 'after' : 'before'
  }
}
