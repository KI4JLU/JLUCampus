import { lazy, Suspense, useEffect, useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Container,
  Spinner
} from '@ki4jlu/design-system'
import type { Language } from '@justcampus/shared'
import { PageHeader } from '@/components/page-header'
import { PageLoading } from '@/components/page-message'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { currentLanguage } from '@/i18n'
import { allNews, newsDate, textIn, type UserNews } from '@/lib/announcements'
import { announcementsQuery, meQuery, useMarkAnnouncementSeen } from '@/lib/queries'

const MarkdownView = lazy(() => import('@/components/markdown-view'))

/**
 * Every news item as a post, newest first, like a blog. Opening the page counts as reading them:
 * the unread ones are acknowledged, so they do not open as a dialog again, and keep their "New"
 * badge until the user leaves the page.
 */
export function NewsPage(): React.JSX.Element {
  const { t } = useTranslation()
  const language = currentLanguage()
  const { data: announcements, isPending, isError, refetch } = useQuery(announcementsQuery)
  const { data: me } = useQuery(meQuery)
  const markSeen = useMarkAnnouncementSeen()
  // The news unread when the page opened; acknowledging them must not take their badge away.
  const [unreadAtOpen, setUnreadAtOpen] = useState<ReadonlySet<string> | null>(null)
  if (announcements && unreadAtOpen === null) {
    setUnreadAtOpen(
      new Set(
        allNews(announcements)
          .filter((item) => !item.seen)
          .map((item) => item.id)
      )
    )
  }

  const userId = me?.id
  const { mutate } = markSeen
  useEffect(() => {
    if (!unreadAtOpen || !userId) return
    unreadAtOpen.forEach((id) => mutate({ id, userId }))
  }, [unreadAtOpen, userId, mutate])

  const news = announcements ? allNews(announcements) : []

  return (
    <Container size="content" className="flex flex-col gap-gutter py-gutter md:py-margin-page">
      <PageHeader title={t('announcements.news.title')} />
      {isPending ? (
        <PageLoading label={t('common.loading')} />
      ) : isError ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-stack-sm">
            {t('announcements.news.loadFailed')}
            <Button variant="secondary" onClick={() => void refetch()}>
              {t('common.retry')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : news.length === 0 ? (
        <p className="m-0 text-body-base text-on-surface-variant">
          {t('announcements.news.empty')}
        </p>
      ) : (
        news.map((item) => (
          <NewsPost
            key={item.id}
            item={item}
            language={language}
            isNew={unreadAtOpen?.has(item.id) ?? false}
          />
        ))
      )}
    </Container>
  )
}

interface NewsPostProps {
  item: UserNews
  language: Language
  isNew: boolean
}

/** One news item: its date, title and text. */
function NewsPost({ item, language, isNew }: NewsPostProps): React.JSX.Element {
  const { t } = useTranslation()
  const titleId = useId()
  const text = textIn(item.texts, language)
  return (
    <article aria-labelledby={titleId}>
      <Card>
        <CardHeader>
          <CardDescription className="flex flex-wrap items-center gap-stack-sm">
            <time dateTime={item.publishedAt}>{newsDate(item.publishedAt, language)}</time>
            {isNew ? (
              <Badge tone="primary" appearance="filled">
                {t('announcements.news.new')}
              </Badge>
            ) : null}
          </CardDescription>
          <CardTitle asChild>
            <h2 id={titleId}>{text.title}</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Suspense fallback={<Spinner label={t('common.loading')} />}>
            <MarkdownView markdown={text.body} breaks />
          </Suspense>
        </CardContent>
      </Card>
    </article>
  )
}
