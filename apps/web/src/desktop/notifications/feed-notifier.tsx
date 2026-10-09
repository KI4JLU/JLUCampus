import { useEffect, useEffectEvent, useMemo, useRef } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { Component, DesktopNotificationsBridge, FeedItem } from '@justcampus/shared'
import { useComponentName } from '@/lib/component-name'
import { hasUnreadEntries } from '@/lib/feed'
import { feedQuery } from '@/lib/queries'
import type { DesktopServiceProps } from '../types'
import { newFeedEntries } from './new-feed-entries'

type RssComponent = Extract<Component, { type: 'rss' }>

/**
 * Watches the feeds in the user's sidebar: a native notification per feed when new unread entries
 * arrive, and the number of feeds with unread entries for the tray and the app badge. The queries
 * are the ones the sidebar and the feed tiles use, so this adds no requests.
 */
export function FeedNotifier({
  bridge,
  components
}: DesktopServiceProps<'notifications'>): React.JSX.Element {
  const feeds = useMemo(
    () => components.filter((component): component is RssComponent => component.type === 'rss'),
    [components]
  )
  const unreadCount = useQueries({
    queries: feeds.map((component) => feedQuery(component.config.feedUrl)),
    combine: (results) =>
      results.filter((result) => result.data && hasUnreadEntries(result.data)).length
  })

  useEffect(() => {
    void bridge.setUnreadCount(unreadCount)
  }, [bridge, unreadCount])

  return (
    <>
      {feeds.map((component) => (
        <FeedWatch
          // A new address is a new feed, whose first copy notifies nothing.
          key={`${component.id} ${component.config.feedUrl}`}
          bridge={bridge}
          component={component}
        />
      ))}
    </>
  )
}

interface FeedWatchProps {
  bridge: DesktopNotificationsBridge
  component: RssComponent
}

/** One feed: notifies about the unread entries each new copy brings. */
function FeedWatch({ bridge, component }: FeedWatchProps): null {
  const { t } = useTranslation()
  const componentName = useComponentName()
  const { data: feed } = useQuery(feedQuery(component.config.feedUrl))
  const seen = useRef<ReadonlySet<string> | undefined>(undefined)

  // Names and texts as they are when the entries arrive.
  const notify = useEffectEvent((entries: FeedItem[]) => {
    const [only] = entries
    void bridge.show({
      title: componentName(component),
      body:
        entries.length === 1 && only
          ? only.title
          : t('desktop.notifications.newEntries', { count: entries.length }),
      path: `/c/${component.id}`
    })
  })

  useEffect(() => {
    if (!feed) return
    const entries = newFeedEntries(seen.current, feed)
    seen.current = new Set(feed.items.map((item) => item.id))
    if (entries.length > 0) notify(entries)
  }, [feed])

  return null
}
