import { useContext, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { PageHeaderExtraActionsContext } from '@/lib/page-header-slots'

interface PageHeaderProps {
  title: ReactNode
  /** Shown before the title, outside the heading, e.g. an icon-only back button. */
  leading?: ReactNode
  /** Muted line below the header, part of the page body. */
  description?: ReactNode
  /** Buttons for the whole page (edit, add). */
  actions?: ReactNode
  className?: string
}

/**
 * A page's one header, at the top of the page: the shell has no bar above it. Actions the route
 * adds (see `PageHeaderExtraActionsContext`) follow the page's own.
 */
export function PageHeader({
  title,
  leading,
  description,
  actions: pageActions,
  className
}: PageHeaderProps): React.JSX.Element {
  const extraActions = useContext(PageHeaderExtraActionsContext)
  const actions = extraActions ? (
    <>
      {pageActions}
      {extraActions}
    </>
  ) : (
    pageActions
  )

  const heading = (
    <h1 className="m-0 flex min-w-0 items-center gap-2 font-headline-md text-headline-md-mobile text-on-surface">
      {title}
    </h1>
  )

  return (
    <header className={cn('flex flex-col gap-stack-sm', className)}>
      <div className="flex flex-wrap items-center justify-between gap-stack-sm">
        {leading ? (
          <div className="flex min-w-0 items-center gap-2">
            {leading}
            {heading}
          </div>
        ) : (
          heading
        )}
        {actions ? <div className="flex flex-wrap items-center gap-stack-sm">{actions}</div> : null}
      </div>
      {description ? (
        <p className="m-0 text-body-base text-on-surface-variant">{description}</p>
      ) : null}
    </header>
  )
}
