import type { TranscriptionSegment } from '@justcampus/shared'
import type { SelectionBounds, SpeakerBlock, TextPoint } from '../segments'

/**
 * Text selections in the rendered transcript, as kiChat's `getSelectionBounds` (T-31, T-33). The
 * transcript marks its elements: `data-block` on a block's text, `data-seg` on everything of a
 * segment, `data-start` on a shown piece (its offset into the segment's text), `data-start` and
 * `data-end` with `data-redacted` on a concealed piece, `data-placeholder` on the placeholder
 * hint and `data-gap` on the blank between two segments. A selection is kept within the block its
 * anchor lies in, as kiChat locks it to one speaker.
 */

export interface BlockSelection {
  block: number
  /** In the open editor: offsets into `draft`, its text then, not into the stored text. */
  bounds: SelectionBounds
  draft?: string
}

function elementOf(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
}

/** The child a boundary inside an element points at, for boundaries between children. */
function childAt(element: Element, offset: number, edge: 'start' | 'end'): Element | null {
  const child = element.childNodes[edge === 'start' ? offset : offset - 1]
  if (!child) return null
  return child.nodeType === Node.ELEMENT_NODE ? (child as Element) : child.parentElement
}

/** Where a DOM boundary lies in the segments, or `null` outside the transcript's text. */
export function domPoint(
  node: Node,
  offset: number,
  edge: 'start' | 'end',
  segments: readonly TranscriptionSegment[]
): TextPoint | null {
  // A boundary between the children of an element: the edge of the child it points at.
  if (node.nodeType === Node.ELEMENT_NODE) {
    const child = childAt(node as Element, offset, edge)
    return elementPoint(child ?? (node as Element), edge, segments)
  }
  const element = elementOf(node)
  const piece = element?.closest('[data-seg]')
  if (!piece) return null
  if (!piece.hasAttribute('data-start') || piece.hasAttribute('data-redacted')) {
    return elementPoint(piece, edge, segments)
  }
  const segment = Number(piece.getAttribute('data-seg'))
  const text = segments[segment]?.text
  if (text === undefined) return null
  const start = Number(piece.getAttribute('data-start'))
  return { segment, offset: Math.min(text.length, start + offset) }
}

/** The edge of a whole element (a concealed piece, the placeholder, a gap, a segment). */
function elementPoint(
  element: Element,
  edge: 'start' | 'end',
  segments: readonly TranscriptionSegment[]
): TextPoint | null {
  const piece = element.closest('[data-seg]')
  if (!piece) return null
  const segment = Number(piece.getAttribute('data-seg'))
  const text = segments[segment]?.text
  if (text === undefined) return null
  if (piece.hasAttribute('data-gap')) {
    // The blank after a segment: a start begins the next one, an end ends this one.
    return edge === 'start' && segments[segment + 1]
      ? { segment: segment + 1, offset: 0 }
      : { segment, offset: text.length }
  }
  if (piece.hasAttribute('data-redacted')) {
    const start = Number(piece.getAttribute('data-start'))
    const end = Number(piece.getAttribute('data-end'))
    return { segment, offset: edge === 'start' ? start : end }
  }
  if (piece.hasAttribute('data-start')) {
    const start = Number(piece.getAttribute('data-start'))
    return { segment, offset: edge === 'start' ? start : start + (piece.textContent?.length ?? 0) }
  }
  return { segment, offset: edge === 'start' ? 0 : text.length }
}

/** The block a node lies in, by its `data-block`. */
export function blockOf(node: Node): number | null {
  const holder = elementOf(node)?.closest('[data-block]')
  return holder ? Number(holder.getAttribute('data-block')) : null
}

/**
 * The selection inside `area` as segment offsets, kept to the block its anchor (where the drag
 * began) lies in, the one the transcript keeps it to on screen; `null` when it is empty, blank or
 * outside.
 */
export function readSelection(
  selection: Selection | null,
  area: Element,
  segments: readonly TranscriptionSegment[],
  blocks: readonly SpeakerBlock[]
): BlockSelection | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  if (selection.toString().trim() === '') return null
  const range = selection.getRangeAt(0)
  if (!area.contains(range.startContainer) || !area.contains(range.endContainer)) return null
  const anchorBlock = selection.anchorNode ? blockOf(selection.anchorNode) : null
  const startBlock = anchorBlock ?? blockOf(range.startContainer)
  if (startBlock === null) return null
  const block = blocks[startBlock]
  if (!block) return null
  // An edge outside the block (a drag not yet cut back) is the block's own edge.
  let start =
    blockOf(range.startContainer) === startBlock
      ? domPoint(range.startContainer, range.startOffset, 'start', segments)
      : null
  start ??= { segment: block.segmentIndices[0]!, offset: 0 }
  let end =
    blockOf(range.endContainer) === startBlock
      ? domPoint(range.endContainer, range.endOffset, 'end', segments)
      : null
  if (!end) {
    const last = block.segmentIndices[block.segmentIndices.length - 1]!
    end = { segment: last, offset: segments[last]?.text.length ?? 0 }
  }
  return { block: startBlock, bounds: { start, end } }
}

// ---------------------------------------------------------------------------
// Touch handles (T-31, kiChat's `CustomSelectionHandles`)
// ---------------------------------------------------------------------------

/** Whether an event target is one of the selection handles (`data-selection-handle`). */
export function isSelectionHandle(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-selection-handle]') !== null
}

/** The text position under a point of the viewport, in whichever way the browser offers it. */
export function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const position = document.caretPositionFromPoint?.(x, y)
  if (position) return { node: position.offsetNode, offset: position.offset }
  // Safari before 17.4 only has the older call.
  const range = (
    document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null }
  ).caretRangeFromPoint?.(x, y)
  return range ? { node: range.startContainer, offset: range.startOffset } : null
}

/**
 * Where a point of the segments lies in the rendered transcript, the reverse of `domPoint`: in a
 * shown piece's text, beside a concealed piece (before it for a start, after it for an end), at
 * the placeholder's edge. `null` when the segment is not rendered.
 */
export function domPosition(
  area: Element,
  point: TextPoint,
  edge: 'start' | 'end'
): { node: Node; offset: number } | null {
  const pieces = area.querySelectorAll(`[data-seg="${point.segment}"][data-start]`)
  for (const piece of pieces) {
    const start = Number(piece.getAttribute('data-start'))
    if (piece.hasAttribute('data-redacted')) {
      const end = Number(piece.getAttribute('data-end'))
      if (point.offset <= start || point.offset >= end) continue
      const parent = piece.parentNode
      if (!parent) continue
      const index = Array.prototype.indexOf.call(parent.childNodes, piece) as number
      return { node: parent, offset: index + (edge === 'end' ? 1 : 0) }
    }
    const text = piece.firstChild
    if (!text || text.nodeType !== Node.TEXT_NODE) continue
    const length = text.textContent?.length ?? 0
    if (point.offset >= start && point.offset <= start + length) {
      return { node: text, offset: point.offset - start }
    }
  }
  const placeholder = area.querySelector(`[data-seg="${point.segment}"][data-placeholder]`)
  if (placeholder) {
    return { node: placeholder, offset: edge === 'start' ? 0 : placeholder.childNodes.length }
  }
  return null
}

/** Selects `bounds` in the rendered transcript; `false` when a point is not rendered. */
export function selectBounds(area: Element, bounds: SelectionBounds): boolean {
  const start = domPosition(area, bounds.start, 'start')
  const end = domPosition(area, bounds.end, 'end')
  const selection = window.getSelection()
  if (!start || !end || !selection) return false
  selection.setBaseAndExtent(start.node, start.offset, end.node, end.offset)
  return true
}

/** Where the selection begins and ends on screen, for its handles and toolbar. */
export interface SelectionRects {
  /** The first line of the selection. */
  first: DOMRect
  /** The last line of the selection. */
  last: DOMRect
  /** Around the whole selection. */
  bounds: DOMRect
}

/** The document's selection on screen while it lies in `area`, else `null`. */
export function measureSelection(area: Element): SelectionRects | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  if (!area.contains(range.commonAncestorContainer)) return null
  const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 || rect.height > 0)
  const first = rects[0]
  const last = rects[rects.length - 1]
  if (!first || !last) return null
  return { first, last, bounds: range.getBoundingClientRect() }
}

/** The box that scrolls `element`, whose visible part the handles keep to; else the viewport. */
export function visibleBox(element: Element): { top: number; bottom: number } {
  for (let current = element.parentElement; current; current = current.parentElement) {
    const { overflowY } = window.getComputedStyle(current)
    if (overflowY === 'auto' || overflowY === 'scroll') {
      const rect = current.getBoundingClientRect()
      return { top: rect.top, bottom: rect.bottom }
    }
  }
  return { top: 0, bottom: window.innerHeight }
}
