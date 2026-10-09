import { ExternalLinkIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button, Container } from '@ki4jlu/design-system'
import { ComponentIcon } from '@/components/component-icon'
import { FeedContent } from '@/components/feed-list'
import { PageHeader } from '@/components/page-header'
import { useComponentName } from '@/lib/component-name'
import { externalLinkProps } from '@/lib/external'
import { useFeed } from '@/lib/use-feed'
import type { ComponentViewProps } from '../types'

/** The whole feed as a column of cards, one per entry with its summary. */
export function RssPage({ component }: ComponentViewProps<'rss'>): React.JSX.Element {
  const { t } = useTranslation()
  const name = useComponentName()(component)
  const {
    data: feed,
    error,
    isPending,
    refetch,
    unreadSince
  } = useFeed(component.config.feedUrl, {
    markReadOnView: true
  })
  const site = feed?.link ?? null
  const description = feed?.title && feed.title !== name ? feed.title : undefined

  return (
    <Container size="reading" className="flex flex-col gap-stack-lg py-gutter md:py-margin-page">
      <PageHeader
        title={
          <>
            <ComponentIcon icon={component.icon} iconUrl={component.iconUrl} />
            <span className="truncate">{name}</span>
          </>
        }
        description={description}
        actions={
          site ? (
            <Button variant="outline" size="sm" asChild>
              <a {...externalLinkProps(site)}>
                <ExternalLinkIcon aria-hidden="true" width="1em" height="1em" />
                {t('feed.openSiteButton')}
              </a>
            </Button>
          ) : undefined
        }
      />
      <FeedContent
        feed={feed}
        error={error}
        pending={isPending}
        unreadSince={unreadSince}
        onRetry={() => void refetch()}
        variant="page"
      />
    </Container>
  )
}
