import type { ReactNode } from 'react'
import { InfoIcon, TriangleAlertIcon } from 'lucide-react'
import { Badge, Card, CardContent } from '@ki4jlu/design-system'
import { cn } from '@/lib/utils'

export type NoticeTone = 'error' | 'warning' | 'info'

export interface NoticeProps {
  tone: NoticeTone
  /** A short line in the tone's colour; without one the message takes its place. */
  title?: string
  children: ReactNode
  /** A button beside the message, e.g. "Erneut versuchen". */
  action?: ReactNode
  /** Inside a card or panel already: without a card of its own. */
  inline?: boolean
  className?: string
}

/**
 * An inline status message from the design system's parts, since it has no Alert: a Card with the
 * tone as a text Badge (icon and title) and the message below. Errors are announced at once,
 * warnings politely, notes not at all.
 */
export function Notice({
  tone,
  title,
  children,
  action,
  inline = false,
  className
}: NoticeProps): React.JSX.Element {
  const Icon = tone === 'info' ? InfoIcon : TriangleAlertIcon
  const role = tone === 'error' ? 'alert' : tone === 'warning' ? 'status' : undefined
  const content = (
    <>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Badge appearance="text" tone={tone}>
          <Icon aria-hidden="true" className="size-4" />
          {title ?? children}
        </Badge>
        {title ? <div>{children}</div> : null}
      </div>
      {action}
    </>
  )
  const layout = 'flex flex-wrap items-center justify-between gap-stack-sm'
  if (inline) {
    return (
      <div role={role} className={cn(layout, className)}>
        {content}
      </div>
    )
  }
  return (
    <Card role={role} className={className}>
      <CardContent className={cn(layout, 'pt-6')}>{content}</CardContent>
    </Card>
  )
}
