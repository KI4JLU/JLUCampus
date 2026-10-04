import type { TranscriptionSegment } from '@justcampus/shared'
import type { SelectionBounds, SpeakerBlock, TextPoint } from '../segments'

/**
 * Text selections in the rendered transcript, as kiChat's `getSelectionBounds` (T-31, T-33). The
 * transcript marks its elements: `data-block` on a block's text, `data-seg` on everything of a
 * segment, `data-start` on a shown piece (its offset into the segment's text), `data-start` and
 * `data-end` with `data-redacted` on a concealed piece, `data-placeholder` on the placeholder
 * hint and `data-gap` on the blank between two segments. A selection is kept within the block it
 * starts in, as kiChat locks it to one speaker.
 */

export interface BlockSelection {
  block: number
  bounds: SelectionBounds
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
function blockOf(node: Node): number | null {
  const holder = elementOf(node)?.closest('[data-block]')
  return holder ? Number(holder.getAttribute('data-block')) : null
}

/**
 * The selection inside `area` as segment offsets, kept to the block it starts in; `null` when it
 * is empty, blank or outside.
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
  const startBlock = blockOf(range.startContainer)
  if (startBlock === null) return null
  const block = blocks[startBlock]
  if (!block) return null
  const start = domPoint(range.startContainer, range.startOffset, 'start', segments)
  let end =
    blockOf(range.endContainer) === startBlock
      ? domPoint(range.endContainer, range.endOffset, 'end', segments)
      : null
  if (!end) {
    const last = block.segmentIndices[block.segmentIndices.length - 1]!
    end = { segment: last, offset: segments[last]?.text.length ?? 0 }
  }
  if (!start) return null
  return { block: startBlock, bounds: { start, end } }
}
