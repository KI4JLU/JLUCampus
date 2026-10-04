import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { GripVerticalIcon, XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button, Popover, PopoverAnchor, PopoverContent } from '@ki4jlu/design-system'
import type { TranscriptionSegment } from '@justcampus/shared'
import {
  moveSelectionEdge,
  stepTextPoint,
  type SelectionBounds,
  type SpeakerBlock
} from '../segments'
import { IconButton } from './icon-button'
import {
  blockOf,
  caretAt,
  domPoint,
  measureSelection,
  selectBounds,
  visibleBox,
  type SelectionRects
} from './selection'

/** Room above the selection's first line for the start handle, which the toolbar keeps clear of. */
const HANDLE_ROOM = 48

interface SelectionPopoverProps {
  open: boolean
  /** Where the toolbar points: the selection's first line, the open editor or a concealed range. */
  anchor: () => DOMRect | null
  /** The transcript, whose scrolling moves the anchor. */
  area: RefObject<HTMLElement | null>
  /** Leaves room for the start handle above the selection. */
  handles: boolean
  /** Presses inside the transcript or on a handle keep the toolbar; it follows the selection. */
  isInside: (target: EventTarget | null) => boolean
  onPointerDown: () => void
  onClose: () => void
  children: React.ReactNode
}

/**
 * kiChat's floating selection toolbar (`#transcript-selection-toolbar`, T-31, T-33): the actions
 * for selected or concealed text in a popover above it, following it while it changes or
 * scrolls. It leaves the focus where it is and does not end the selection when pressed; Escape or
 * a press elsewhere closes it and ends the selection.
 */
export function SelectionPopover({
  open,
  anchor,
  area,
  handles,
  isInside,
  onPointerDown,
  onClose,
  children
}: SelectionPopoverProps): React.JSX.Element {
  const { t } = useTranslation()
  // Radix reads the anchor after every render; `contextElement` lets it watch the scrolling.
  const virtual = useMemo(
    () => ({
      current: {
        getBoundingClientRect: () => anchor() ?? new DOMRect(),
        contextElement: area.current ?? undefined
      }
    }),
    [anchor, area]
  )
  return (
    <Popover open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <PopoverAnchor virtualRef={virtual} />
      <PopoverContent
        side="top"
        sideOffset={handles ? HANDLE_ROOM : 8}
        updatePositionStrategy="always"
        hideWhenDetached
        className="w-auto"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => {
          if (isInside(event.target)) event.preventDefault()
        }}
        onPointerDown={onPointerDown}
        // Keeps the text selection (and an editor's focus) while a button is pressed.
        onMouseDown={(event) => event.preventDefault()}
      >
        <div
          role="toolbar"
          aria-label={t('transcription.result.selectionActions')}
          className="flex flex-wrap items-center gap-2"
        >
          {children}
          <IconButton label={t('transcription.common.close')} onClick={onClose}>
            <XIcon aria-hidden="true" className="size-4" />
          </IconButton>
        </div>
      </PopoverContent>
    </Popover>
  )
}

interface SelectionHandlesProps {
  area: RefObject<HTMLElement | null>
  segments: readonly TranscriptionSegment[]
  block: SpeakerBlock
  bounds: SelectionBounds
}

type Edge = 'start' | 'end'

/**
 * kiChat's custom touch selection handles (`CustomSelectionHandles`, T-31): one above the start
 * and one below the end of the selected text, dragged with finger or mouse to move that edge, or
 * with the arrow keys one character at a time. The selection stays within its speaker block, and
 * the handles hide while their line is scrolled out of view.
 */
export function SelectionHandles({
  area,
  segments,
  block,
  bounds
}: SelectionHandlesProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const [rects, setRects] = useState<SelectionRects | null>(null)
  const [box, setBox] = useState<{ top: number; bottom: number } | null>(null)
  /** The bounds last set, ahead of the state that follows the document's selection. */
  const latest = useRef(bounds)
  /** The edge being dragged, and the way from the pointer to the text line it points at. */
  const grab = useRef<{ edge: Edge; dx: number; dy: number } | null>(null)

  useEffect(() => {
    latest.current = bounds
  }, [bounds])

  // Follows the selection on screen: when it changes, and when the page scrolls or resizes.
  useEffect(() => {
    const holder = area.current
    if (!holder) return
    let frame = 0
    const measure = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        setRects(measureSelection(holder))
        setBox(visibleBox(holder))
      })
    }
    measure()
    document.addEventListener('selectionchange', measure)
    window.addEventListener('scroll', measure, true)
    window.addEventListener('resize', measure)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('selectionchange', measure)
      window.removeEventListener('scroll', measure, true)
      window.removeEventListener('resize', measure)
    }
  }, [area, bounds])

  /** Moves an edge to a point of the text, if it stays in the block and selects something. */
  const moveTo = (edge: Edge, x: number, y: number): void => {
    const holder = area.current
    const caret = caretAt(x, y)
    if (!holder || !caret || !holder.contains(caret.node)) return
    if (blockOf(caret.node) !== block.index) return
    const point = domPoint(caret.node, caret.offset, edge, segments)
    if (!point) return
    apply(moveSelectionEdge(segments, block, latest.current, edge, point))
  }

  const apply = (next: SelectionBounds | null): void => {
    const holder = area.current
    if (next && holder && selectBounds(holder, next)) latest.current = next
  }

  if (!rects || !box) return null

  const handle = (edge: Edge): React.JSX.Element | null => {
    const line = edge === 'start' ? rects.first : rects.last
    if (line.top < box.top || line.bottom > box.bottom) return null
    const x = edge === 'start' ? line.left : line.right
    const middle = line.top + line.height / 2
    return (
      // DS gap: no selection handle; a DS icon button is placed at the selection's edge, without
      // the button's transition so it keeps up with the finger.
      <Button
        key={edge}
        type="button"
        variant="default"
        size="icon"
        data-selection-handle=""
        aria-label={t(
          edge === 'start'
            ? 'transcription.result.selectionStart'
            : 'transcription.result.selectionEnd'
        )}
        className={`fixed z-50 -translate-x-1/2 touch-none transition-none ${edge === 'start' ? '-translate-y-full' : ''}`}
        style={{ left: x, top: edge === 'start' ? line.top : line.bottom }}
        onMouseDown={(event) => event.preventDefault()}
        onPointerDown={(event) => {
          event.preventDefault()
          event.currentTarget.setPointerCapture(event.pointerId)
          grab.current = { edge, dx: x - event.clientX, dy: middle - event.clientY }
        }}
        onPointerMove={(event) => {
          const current = grab.current
          if (current) moveTo(current.edge, event.clientX + current.dx, event.clientY + current.dy)
        }}
        onPointerUp={() => {
          grab.current = null
        }}
        onPointerCancel={() => {
          grab.current = null
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          event.preventDefault()
          const from = edge === 'start' ? latest.current.start : latest.current.end
          const point = stepTextPoint(segments, block, from, event.key === 'ArrowLeft' ? -1 : 1)
          if (point) apply(moveSelectionEdge(segments, block, latest.current, edge, point))
        }}
      >
        <GripVerticalIcon aria-hidden="true" className="size-4" />
      </Button>
    )
  }

  return createPortal(
    <>
      {handle('start')}
      {handle('end')}
    </>,
    document.body
  )
}
