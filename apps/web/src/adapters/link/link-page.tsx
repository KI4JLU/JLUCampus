import { ExternalLinkIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@ki4jlu/design-system'
import { PageMessage } from '@/components/page-message'
import { useComponentName } from '@/lib/component-name'
import { externalLinkProps } from '@/lib/external'
import { hostnameTitle } from '@/lib/links'
import type { ComponentViewProps } from '../types'

/**
 * Shortcuts open outside the app from every entry point, so this page is only
 * reached by typing or bookmarking `/c/$componentId`. It offers the way out.
 */
export function LinkPage({ component }: ComponentViewProps<'link'>): React.JSX.Element {
  const { t } = useTranslation()
  const componentName = useComponentName()
  const { url } = component.config
  return (
    <PageMessage
      icon={<ExternalLinkIcon />}
      title={componentName(component)}
      description={t('component.link.pageDescription', { host: hostnameTitle(url) })}
      actions={
        <Button asChild>
          <a {...externalLinkProps(url)}>
            <ExternalLinkIcon aria-hidden="true" width="1em" height="1em" />
            {t('component.link.open')}
          </a>
        </Button>
      }
    />
  )
}
