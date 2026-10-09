import {
  useEffect,
  useId,
  useMemo,
  useRef,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode
} from 'react'
import { XIcon } from 'lucide-react'
import { Button, Popover, PopoverAnchor, PopoverContent } from '@ki4jlu/design-system'
import type { AnnouncementSide } from '@justcampus/shared'
import { hintMarker } from '@/lib/hint-anchor'
import { leavesHint, pageControlBeside, relationTo, tabbablesIn } from '@/lib/hint-focus'
import { AnnouncementBody } from './announcement-body'

const ICON = { 'aria-hidden': true, width: '1em', height: '1em' } as const

interface HintPopoverProps {
  /** The element the hint points at. */
  anchor: Element
  side: AnnouncementSide
  title: string
  body: string
  /** Above the title, e.g. the preview's badge. */
  badge?: ReactNode
  /** Under the text, e.g. the preview's note on the page path. */
  note?: ReactNode
  /** The buttons at the foot. */
  actions: ReactNode
  /** The close button's name; it and Escape call `onClose`. */
  closeLabel: string
  onClose: () => void
}

/**
 * A small pop-up beside an element of the page. It leaves the focus where it is and stays when
 * the user clicks elsewhere, so it never interrupts work on the page; only its buttons or Escape
 * close it. The host closes it once its element leaves the view. For the keyboard it sits right
 * after its element: Tab moves through it and on into the page (Radix would loop inside it), and
 * when it closes with the focus inside, the focus goes back to the element.
 */
export function HintPopover({
  anchor,
  side,
  title,
  body,
  badge,
  note,
  actions,
  closeLabel,
  onClose
}: HintPopoverProps): React.JSX.Element {
  const titleId = useId()
  const virtualRef = useMemo(() => ({ current: anchor }), [anchor])
  // Whether the focus is in the hint; still set once its focused button is removed with it.
  const focusInside = useRef(false)

  // Gone with the focus inside: the focus would fall to the page's start, so it goes back to the
  // element (or the control nearest before it).
  useEffect(
    () => () => {
      const lost = document.activeElement === null || document.activeElement === document.body
      if (!focusInside.current || !lost || !anchor.isConnected) return
      const controls = tabbablesIn(document.body)
      pageControlBeside(controls, relationTo(anchor), true)?.focus()
    },
    [anchor]
  )

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return
    const content = event.currentTarget
    const backwards = event.shiftKey
    if (!leavesHint<Element | null>(tabbablesIn(content), document.activeElement, backwards)) return
    // Runs before Radix' loop, which then finds the focus outside and leaves it there.
    event.preventDefault()
    const next = anchor.isConnected
      ? pageControlBeside(tabbablesIn(document.body, content), relationTo(anchor), backwards)
      : null
    if (next) next.focus()
    else if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  }

  const handleBlur = (event: FocusEvent<HTMLDivElement>): void => {
    const content = event.currentTarget
    if (event.relatedTarget instanceof Node) {
      focusInside.current = content.contains(event.relatedTarget)
      return
    }
    // Focus to nowhere: a click on the page, or the hint going away with its focused button. Only
    // the first leaves it; the second is for the clean-up above.
    requestAnimationFrame(() => {
      if (content.isConnected && !content.contains(document.activeElement)) {
        focusInside.current = false
      }
    })
  }

  return (
    <Popover open>
      <PopoverAnchor virtualRef={virtualRef} />
      {/* DS gap: Popover shares z-50 with panels and dialogs; a hint opened by the click that
          opens a panel must stay above it. */}
      <PopoverContent
        className="z-60"
        side={side}
        collisionPadding={12}
        hideWhenDetached
        aria-labelledby={titleId}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={onClose}
        onKeyDown={handleKeyDown}
        {...hintMarker}
        onFocus={() => {
          focusInside.current = true
        }}
        onBlur={handleBlur}
      >
        <div className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-2">
            <div className="flex flex-col items-start gap-1">
              {badge}
              {/* DS gap: Popover has no title part; the heading takes the "More apps" panel's. */}
              <h2 id={titleId} className="m-0 font-semibold">
                {title}
              </h2>
            </div>
            <Button variant="ghost" size="icon" aria-label={closeLabel} onClick={onClose}>
              <XIcon {...ICON} />
            </Button>
          </div>
          <AnnouncementBody body={body} />
          {note}
          <div className="flex flex-wrap justify-end gap-2">{actions}</div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
