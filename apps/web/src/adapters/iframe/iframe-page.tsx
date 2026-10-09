import { isUnauthorized } from '@/lib/api'
import { useCollapsedSidebar } from '@/lib/collapse-sidebar'
import { useComponentName } from '@/lib/component-name'
import { useSessionCheck } from '@/lib/queries'
import type { ComponentViewProps } from '../types'
import { IframeEmbed } from './embed'

/**
 * Nothing but the embedded site, with the navigation column folded: the site often brings a
 * header and navigation of its own.
 */
export function IframePage({ component }: ComponentViewProps<'iframe'>): React.JSX.Element {
  useCollapsedSidebar()
  const name = useComponentName()(component)
  // A 401 leads to the login page; any other failed check still shows the site.
  const sessionCheck = useSessionCheck(component.id)
  const showSite =
    sessionCheck.isSuccess || (sessionCheck.isError && !isUnauthorized(sessionCheck.error))
  return showSite ? (
    <IframeEmbed url={component.config.url} title={name} className="min-h-0 flex-1" />
  ) : (
    <div className="min-h-0 flex-1" />
  )
}
