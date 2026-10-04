import type { ReactNode } from 'react'
import { CircleAlertIcon, TriangleAlertIcon } from 'lucide-react'
import { Badge, Card, CardContent, CardDescription } from '@ki4jlu/design-system'

/**
 * An inline error or warning of the transcription page, composed from DS parts since the design
 * system exports no Alert: a Card, the message as a Badge in the tone's colour with its icon, an
 * optional description below and an optional action (a DS Button) beside it. Errors are announced
 * at once (`role="alert"`), warnings politely (`role="status"`).
 */
export function Notice({
  tone,
  title,
  description,
  action
}: {
  tone: 'error' | 'warning'
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
}): React.JSX.Element {
  const Icon = tone === 'error' ? CircleAlertIcon : TriangleAlertIcon
  return (
    <Card role={tone === 'error' ? 'alert' : 'status'}>
      <CardContent className="flex flex-wrap items-center justify-between gap-stack-sm">
        <div className="flex min-w-0 flex-col gap-1">
          <Badge appearance="text" tone={tone}>
            <Icon aria-hidden="true" className="size-4" />
            {title}
          </Badge>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </div>
        {action}
      </CardContent>
    </Card>
  )
}
