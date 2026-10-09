import { useId, useMemo, type ReactNode } from 'react'
import { XIcon } from 'lucide-react'
import { Button, Popover, PopoverAnchor, PopoverContent } from '@ki4jlu/design-system'
import type { AnnouncementSide } from '@justcampus/shared'
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
 * close it. It hides while its element is scrolled out of view.
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
  return (
    <Popover open>
      <PopoverAnchor virtualRef={virtualRef} />
      <PopoverContent
        side={side}
        collisionPadding={12}
        hideWhenDetached
        aria-labelledby={titleId}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={onClose}
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
