import { ExternalLinkIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@ki4jlu/design-system'
import { ComponentIcon } from '@/components/component-icon'
import { PageHeader } from '@/components/page-header'
import { isUnauthorized } from '@/lib/api'
import { openExternal } from '@/lib/external'
import { useSessionCheck } from '@/lib/queries'
import type { ComponentViewProps } from '../types'
import { IframeEmbed } from './embed'

export function IframePage({ component }: ComponentViewProps<'iframe'>): React.JSX.Element {
  const { t } = useTranslation()
  const { url } = component.config
  // A 401 leads to the login page; any other failed check still shows the site.
  const sessionCheck = useSessionCheck(component.id)
  const showSite =
    sessionCheck.isSuccess || (sessionCheck.isError && !isUnauthorized(sessionCheck.error))
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        className="border-b border-outline-variant px-gutter py-3"
        title={
          <>
            <ComponentIcon icon={component.icon} iconUrl={component.iconUrl} />
            <span className="truncate">{component.name}</span>
          </>
        }
        description={t('component.iframe.embedHint')}
        actions={
          <Button variant="outline" size="sm" onClick={() => openExternal(url)}>
            <ExternalLinkIcon aria-hidden="true" width="1em" height="1em" />
            {t('component.iframe.openInNewTab')}
          </Button>
        }
      />
      {showSite ? (
        <IframeEmbed url={url} title={component.name} className="min-h-0 flex-1" />
      ) : (
        <div className="min-h-0 flex-1" />
      )}
    </div>
  )
}
