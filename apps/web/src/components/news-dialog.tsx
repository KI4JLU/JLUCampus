import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Button } from '@ki4jlu/design-system'
import type { Language } from '@justcampus/shared'
import { newsDate, textIn, type UserNews } from '@/lib/announcements'
import { AnnouncementDialog } from './announcement-dialog'

interface NewsDialogProps {
  open: boolean
  /** The pages, in order; fixed while the dialog is open. */
  items: UserNews[]
  language: Language
  /** As the dialog closes, with the items the user paged to. */
  onClose: (viewedIds: string[]) => void
}

/**
 * News items one page each, with Back and Next, the last page's button closing the dialog. The
 * items the user actually paged to count as read; closing early leaves the rest for next time.
 * "All news" closes it too and goes to the news page, which counts every item as read.
 */
export function NewsDialog({ open, items, language, onClose }: NewsDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const [page, setPage] = useState(0)
  // The furthest page shown so far: every page up to it was viewed.
  const [furthest, setFurthest] = useState(0)
  const [announced, setAnnounced] = useState('')
  const item = items[page]
  const text = item ? textIn(item.texts, language) : null
  const isLast = page >= items.length - 1

  const close = (): void => onClose(items.slice(0, furthest + 1).map((news) => news.id))

  const goTo = (next: number): void => {
    const target = items[next]
    if (!target) return
    setPage(next)
    setFurthest((current) => Math.max(current, next))
    // The focus stays on the button, so the new page is read out from here.
    setAnnounced(
      t('announcements.news.pageChanged', {
        current: next + 1,
        total: items.length,
        title: textIn(target.texts, language).title
      })
    )
  }

  return (
    <AnnouncementDialog
      open={open}
      onClose={close}
      meta={
        !item
          ? t('announcements.news.empty')
          : items.length > 1
            ? t('announcements.news.meta', {
                date: newsDate(item.publishedAt, language),
                current: page + 1,
                total: items.length
              })
            : newsDate(item.publishedAt, language)
      }
      title={text ? text.title : t('announcements.news.title')}
      body={text ? text.body : null}
      footer={
        <>
          <Button asChild variant="link" className="sm:me-auto">
            <Link to="/news" onClick={close}>
              {t('announcements.news.all')}
            </Link>
          </Button>
          {items.length > 1 ? (
            <Button variant="secondary" disabled={page === 0} onClick={() => goTo(page - 1)}>
              {t('announcements.news.back')}
            </Button>
          ) : null}
          {isLast ? (
            <Button onClick={close}>{t('announcements.news.done')}</Button>
          ) : (
            <Button onClick={() => goTo(page + 1)}>{t('announcements.news.next')}</Button>
          )}
        </>
      }
    >
      <p className="sr-only" aria-live="polite">
        {announced}
      </p>
    </AnnouncementDialog>
  )
}
