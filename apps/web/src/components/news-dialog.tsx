import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@ki4jlu/design-system'
import type { Language } from '@justcampus/shared'
import { textIn, type UserNews } from '@/lib/announcements'
import { AnnouncementBody } from './announcement-body'

interface NewsDialogProps {
  open: boolean
  /** The pages, in order; fixed while the dialog is open. */
  items: UserNews[]
  language: Language
  /** As the dialog closes, with the items the user paged to. */
  onClose: (viewedIds: string[]) => void
  onCloseAutoFocus?: (event: Event) => void
}

/**
 * News items one page each, with Back and Next, the last page's button closing the dialog. The
 * items the user actually paged to count as read; closing early leaves the rest for next time.
 */
export function NewsDialog({
  open,
  items,
  language,
  onClose,
  onCloseAutoFocus
}: NewsDialogProps): React.JSX.Element {
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
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <DialogContent closeLabel={t('common.close')} onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogDescription>
            {!item
              ? t('announcements.news.empty')
              : items.length > 1
                ? t('announcements.news.meta', {
                    date: formatDate(item.publishedAt, language),
                    current: page + 1,
                    total: items.length
                  })
                : formatDate(item.publishedAt, language)}
          </DialogDescription>
          <DialogTitle>{text ? text.title : t('announcements.news.title')}</DialogTitle>
        </DialogHeader>
        {text ? (
          // Long texts scroll inside the dialog; the buttons stay in view.
          <div className="max-h-96 overflow-y-auto">
            <AnnouncementBody body={text.body} />
          </div>
        ) : null}
        <p className="sr-only" aria-live="polite">
          {announced}
        </p>
        <DialogFooter>
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function formatDate(iso: string, language: Language): string {
  return new Intl.DateTimeFormat(language, { dateStyle: 'long' }).format(new Date(iso))
}
