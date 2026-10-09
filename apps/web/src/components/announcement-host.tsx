import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Badge, Button } from '@ki4jlu/design-system'
import { announcementPathMatches, type Language, type UserAnnouncement } from '@justcampus/shared'
import { currentLanguage } from '@/i18n'
import {
  allNews,
  hintQueue,
  previewOwnedBy,
  textIn,
  unreadNews,
  type AnnouncementPreview,
  type UserNews
} from '@/lib/announcements'
import {
  clearAnnouncementPreview,
  endAnnouncementPreview,
  useAnnouncementPreview
} from '@/lib/announcement-preview'
import { OpenNewsContext } from '@/lib/news-context'
import { announcementsQuery, meQuery, useMarkAnnouncementSeen } from '@/lib/queries'
import { toast } from '@/lib/toast'
import { useVisibleTarget } from '@/lib/use-visible-target'
import { HintPopover } from './hint-popover'
import { NewsDialog } from './news-dialog'

/** How long a preview looks for its element on a page before it says it found none. */
const PREVIEW_NOT_FOUND_MS = 4000

interface NewsSession {
  /** Remounts the dialog per opening, so it starts on its first page. */
  key: number
  open: boolean
  items: UserNews[]
  /** Gets the focus back as the dialog closes. */
  opener: HTMLElement | null
}

/**
 * Shows the user's announcements in the signed-in app: unread news as a dialog once the app has
 * started, then the hints of the current page one at a time, never both at once. While an admin
 * tries a hint out from its editor, that preview takes the hints' place, for that admin only.
 * `children` (the app frame) can reopen the news from `OpenNewsContext`.
 */
export function AnnouncementHost({ children }: { children: ReactNode }): React.JSX.Element {
  // Re-renders on a language switch, which shows the other language at once.
  useTranslation()
  const language = currentLanguage()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const { data: announcements } = useQuery(announcementsQuery)
  const { data: me } = useQuery(meQuery)
  const stored = useAnnouncementPreview()
  // Another user's preview left in this tab (or one whose admin role is gone) is dropped unseen.
  const preview = previewOwnedBy(stored, me) ? stored : null
  const foreignPreview = stored !== null && me !== undefined && preview === null
  const markSeen = useMarkAnnouncementSeen()
  const [news, setNews] = useState<NewsSession | null>(null)
  const [startChecked, setStartChecked] = useState(false)

  // The first list after the app started opens the unread news, once.
  if (announcements && !startChecked) {
    setStartChecked(true)
    const unread = unreadNews(announcements)
    if (unread.length > 0) setNews({ key: 0, open: true, items: unread, opener: null })
  }

  const openNews = useCallback(
    (opener: HTMLElement | null) =>
      setNews((current) => ({
        key: (current?.key ?? 0) + 1,
        open: true,
        items: allNews(announcements ?? []),
        opener
      })),
    [announcements]
  )

  const closeNews = (viewedIds: string[]): void => {
    setNews((current) => (current ? { ...current, open: false } : current))
    const unseen = new Set(announcements?.filter((item) => !item.seen).map((item) => item.id))
    viewedIds.filter((id) => unseen.has(id)).forEach((id) => markSeen.mutate(id))
  }

  useEffect(() => {
    if (foreignPreview) clearAnnouncementPreview()
  }, [foreignPreview])

  const newsOpen = news?.open ?? false
  const previewing = preview?.active === true && preview.form.kind === 'hint'

  return (
    <OpenNewsContext.Provider value={openNews}>
      {children}
      {news ? (
        <NewsDialog
          key={news.key}
          open={news.open}
          items={news.items}
          language={language}
          onClose={closeNews}
          onCloseAutoFocus={(event) => {
            if (!news.opener?.isConnected) return
            event.preventDefault()
            news.opener.focus()
          }}
        />
      ) : null}
      {previewing ? (
        <PreviewHint preview={preview} pathname={pathname} language={language} paused={newsOpen} />
      ) : announcements ? (
        <PageHints
          announcements={announcements}
          pathname={pathname}
          language={language}
          paused={newsOpen}
          onSeen={(id) => markSeen.mutate(id)}
        />
      ) : null}
    </OpenNewsContext.Provider>
  )
}

interface PageHintsProps {
  announcements: UserAnnouncement[]
  pathname: string
  language: Language
  /** While the news dialog is open, no hint shows. */
  paused: boolean
  onSeen: (id: string) => void
}

/**
 * The page's unread hints take turns, oldest first; one shows as soon as its element is on
 * screen. A hint whose element goes away hides until it is back; only "Got it", the close button
 * or Escape mark it seen.
 */
function PageHints({
  announcements,
  pathname,
  language,
  paused,
  onSeen
}: PageHintsProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const queue = paused ? [] : hintQueue(announcements, pathname)
  const target = useVisibleTarget(queue.map((hint) => hint.target.selector))
  const hint = target ? queue[target.index] : undefined
  if (!target || !hint) return null
  const text = textIn(hint.texts, language)
  const acknowledge = (): void => onSeen(hint.id)
  return (
    <HintPopover
      key={hint.id}
      anchor={target.element}
      side={hint.target.side}
      title={text.title}
      body={text.body}
      closeLabel={t('common.close')}
      onClose={acknowledge}
      actions={
        <Button size="sm" onClick={acknowledge}>
          {t('announcements.hint.gotIt')}
        </Button>
      }
    />
  )
}

interface PreviewHintProps {
  preview: AnnouncementPreview
  pathname: string
  language: Language
  paused: boolean
}

/**
 * The hint an admin tries out, unsaved, on whichever page they open, whether or not its page path
 * would show it there (it says when not). It marks nothing seen. When a page has no such element
 * after a few seconds, a toast says so; the preview stays for the next page.
 */
function PreviewHint({
  preview,
  pathname,
  language,
  paused
}: PreviewHintProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { form, announcementId } = preview
  const selector = form.selector.trim()
  const target = useVisibleTarget(paused || !selector ? [] : [selector])
  const found = target !== null

  useEffect(() => {
    if (found || paused) return
    const timer = window.setTimeout(
      () =>
        toast({
          variant: 'warning',
          title: t('announcements.preview.notFound'),
          description: t('announcements.preview.notFoundDescription')
        }),
      PREVIEW_NOT_FOUND_MS
    )
    return () => window.clearTimeout(timer)
  }, [found, paused, pathname, t])

  if (!target) return null
  const text = textIn(form.texts, language)
  const path = form.path.trim()
  const shownHere = announcementPathMatches(path ? path : null, pathname)

  const backToEditor = (): void => {
    void (announcementId
      ? navigate({
          to: '/admin/announcements/$announcementId',
          params: { announcementId }
        })
      : navigate({ to: '/admin/announcements/new' }))
  }

  return (
    <HintPopover
      anchor={target.element}
      side={form.side}
      title={text.title.trim() || t('announcements.preview.untitled')}
      body={text.body}
      badge={
        <Badge tone="info" appearance="filled">
          {t('announcements.preview.badge')}
        </Badge>
      }
      note={
        shownHere ? null : (
          <Badge tone="warning" appearance="text">
            {t('announcements.preview.otherPath')}
          </Badge>
        )
      }
      closeLabel={t('announcements.preview.end')}
      onClose={endAnnouncementPreview}
      actions={
        <>
          <Button size="sm" variant="secondary" onClick={endAnnouncementPreview}>
            {t('announcements.preview.end')}
          </Button>
          <Button size="sm" onClick={backToEditor}>
            {t('announcements.preview.back')}
          </Button>
        </>
      }
    />
  )
}
