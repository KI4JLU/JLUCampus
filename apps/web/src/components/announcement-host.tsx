import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Badge, Button } from '@ki4jlu/design-system'
import { announcementPathMatches, type Language } from '@justcampus/shared'
import { currentLanguage } from '@/i18n'
import {
  closestMatch,
  hintForClick,
  previewOwnedBy,
  textIn,
  unreadNews,
  type AnnouncementPreview,
  type UserHint,
  type UserNews
} from '@/lib/announcements'
import {
  clearAnnouncementPreview,
  endAnnouncementPreview,
  useAnnouncementPreview
} from '@/lib/announcement-preview'
import { hintMarker, isReplaying, replayClick } from '@/lib/hint-layer'
import { announcementsQuery, meQuery, useMarkAnnouncementSeen } from '@/lib/queries'
import { toast } from '@/lib/toast'
import { useVisibleTarget } from '@/lib/use-visible-target'
import { AnnouncementDialog } from './announcement-dialog'
import { NewsDialog } from './news-dialog'

/** The news page, where the unread news need no dialog. */
const NEWS_PATH = '/news'

/** How long a preview looks for its element on a page before it says it found none. */
const PREVIEW_NOT_FOUND_MS = 4000

/** Keys that activate the focused control. */
const ACTIVATING_KEYS = new Set(['Enter', ' '])

/** The events of a click (or key) a hint holds back; the press opens it, the rest follow. */
const HELD_EVENTS = [
  'pointerdown',
  'mousedown',
  'pointerup',
  'mouseup',
  'click',
  'keydown'
] as const

/** How long after the press the rest of the same click is held back too. */
const GESTURE_MS = 1000

/** The hint a click opened, and the element whose action waits for it. */
type OpenedHint =
  { kind: 'hint'; id: string; element: Element } | { kind: 'preview'; element: Element }

interface NewsSession {
  open: boolean
  items: UserNews[]
}

/**
 * Shows the user's announcements in the signed-in app: unread news as a dialog once the app has
 * started (unless it started on the news page, which shows them anyway), and an unread hint, as a dialog of its own, when the user clicks its element.
 * Listeners on the document (capture phase, so they see every click first) find the hint: the
 * oldest unread one for the page whose element is the clicked one or contains it. The click is held
 * back, so the info comes first; "Got it" then plays the click again and the element's action
 * runs. Closing the hint otherwise cancels the action. One hint at a time: clicks open nothing
 * while a hint or the news are open. While an admin tries a hint out
 * from its editor, that preview takes the hints' place, for that admin only. `children` is the
 * app frame.
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
  const acknowledge = (id: string): void => {
    if (me) markSeen.mutate({ id, userId: me.id })
  }
  const [news, setNews] = useState<NewsSession | null>(null)
  const [opened, setOpened] = useState<OpenedHint | null>(null)
  // The element whose click is being held back, and since when; the click to play after closing.
  const held = useRef<{ element: Element; since: number } | null>(null)
  const replay = useRef<Element | null>(null)
  const [startChecked, setStartChecked] = useState(false)

  // The first list after the app started opens the unread news, once.
  if (announcements && !startChecked) {
    setStartChecked(true)
    const unread = unreadNews(announcements)
    if (unread.length > 0 && pathname.replace(/\/+$/, '') !== NEWS_PATH)
      setNews({ open: true, items: unread })
  }

  const closeNews = (viewedIds: string[]): void => {
    setNews((current) => (current ? { ...current, open: false } : current))
    const unseen = new Set(announcements?.filter((item) => !item.seen).map((item) => item.id))
    viewedIds.filter((id) => unseen.has(id)).forEach(acknowledge)
  }

  useEffect(() => {
    if (foreignPreview) clearAnnouncementPreview()
  }, [foreignPreview])

  const newsOpen = news?.open ?? false
  const previewing = preview?.active === true && preview.form.kind === 'hint'
  // What the click opened, while it still applies: the hint still unread, the preview still on.
  const openHint =
    opened?.kind === 'hint' && !previewing
      ? announcements?.find(
          (item): item is UserHint => item.kind === 'hint' && item.id === opened.id && !item.seen
        )
      : undefined
  const openPreview = opened?.kind === 'preview' && previewing ? preview : null
  const active = openHint !== undefined || openPreview !== null

  const find = useEffectEvent((target: EventTarget | null): OpenedHint | null => {
    if (newsOpen || active || !(target instanceof Element)) return null
    const closest = (selector: string): Element | null => target.closest(selector)
    if (previewing) {
      const element = closestMatch(preview.form.selector.trim(), closest)
      return element ? { kind: 'preview', element } : null
    }
    const match = announcements ? hintForClick(announcements, pathname, closest) : null
    return match ? { kind: 'hint', id: match.hint.id, element: match.element } : null
  })

  // The press (or Enter/Space) on a hint's element opens the hint and is stopped before the app
  // sees it, like the rest of that click, so neither the press nor the click runs the action.
  useEffect(() => {
    const hold = (event: Event): void => {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    const onEvent = (event: Event): void => {
      if (isReplaying()) return
      if (event instanceof MouseEvent && event.button !== 0) return
      if (event instanceof KeyboardEvent && !ACTIVATING_KEYS.has(event.key)) return
      const target = event.target
      const current = held.current
      if (
        current &&
        performance.now() - current.since < GESTURE_MS &&
        target instanceof Node &&
        current.element.contains(target)
      ) {
        hold(event)
        return
      }
      if (event.type === 'pointerup' || event.type === 'mouseup') return
      const next = find(target)
      if (!next) return
      hold(event)
      held.current = { element: next.element, since: performance.now() }
      setOpened(next)
    }
    for (const type of HELD_EVENTS) document.addEventListener(type, onEvent, true)
    return () => {
      for (const type of HELD_EVENTS) document.removeEventListener(type, onEvent, true)
    }
  }, [])

  const close = (): void => setOpened(null)

  // Runs once the dialog has closed and given the focus back, so the action starts from there.
  const afterClose = (): void => {
    held.current = null
    const element = replay.current
    replay.current = null
    if (element) window.setTimeout(() => replayClick(element))
  }

  return (
    <>
      {children}
      {news ? (
        <NewsDialog open={news.open} items={news.items} language={language} onClose={closeNews} />
      ) : null}
      {previewing ? <PreviewNotices pathname={pathname} selector={preview.form.selector} /> : null}
      {openPreview ? (
        <PreviewHint
          preview={openPreview}
          pathname={pathname}
          language={language}
          onClose={close}
          onClosed={afterClose}
        />
      ) : null}
      {openHint && opened ? (
        <PageHint
          key={openHint.id}
          hint={openHint}
          language={language}
          onClose={(proceed) => {
            acknowledge(openHint.id)
            if (proceed) replay.current = opened.element
            close()
          }}
          onClosed={afterClose}
        />
      ) : null}
    </>
  )
}

interface PageHintProps {
  hint: UserHint
  language: Language
  /** `proceed` for "Got it", which goes on with the held-back action. */
  onClose: (proceed: boolean) => void
  /** Once the dialog is gone and the focus is back. */
  onClosed: () => void
}

/**
 * An unread hint a click opened. Closing it in any way marks it seen; "Got it" also goes on with
 * the click it held back, the close button and Escape cancel that.
 */
function PageHint({ hint, language, onClose, onClosed }: PageHintProps): React.JSX.Element {
  const { t } = useTranslation()
  const text = textIn(hint.texts, language)
  return (
    <AnnouncementDialog
      open
      onClose={() => onClose(false)}
      onCloseAutoFocus={onClosed}
      meta={t('announcements.hint.label')}
      title={text.title}
      body={text.body}
      frameProps={hintMarker}
      footer={<Button onClick={() => onClose(true)}>{t('announcements.hint.gotIt')}</Button>}
    />
  )
}

/**
 * While a preview is on: says so on arrival, and when a page has no element for its selector on
 * screen after a few seconds, says that too; the preview stays for the next page.
 */
function PreviewNotices({ pathname, selector }: { pathname: string; selector: string }): null {
  const { t } = useTranslation()
  const trimmed = selector.trim()
  const found = useVisibleTarget(trimmed ? [trimmed] : []) !== null

  const announce = useEffectEvent(() =>
    toast({
      variant: 'info',
      title: t('announcements.preview.active'),
      description: t('announcements.preview.activeDescription')
    })
  )
  // Once per preview (and page load), not again on every page.
  useEffect(() => announce(), [])

  useEffect(() => {
    if (found) return
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
  }, [found, pathname, t])

  return null
}

interface PreviewHintProps {
  preview: AnnouncementPreview
  pathname: string
  language: Language
  onClose: () => void
  onClosed: () => void
}

/**
 * The hint an admin tries out, unsaved, opened by a click on its element on whichever page they
 * are, whether or not its page path would offer it there (it says when not). It marks nothing
 * seen and holds the click back like the real one, but never plays it again; closing it keeps the
 * preview on for the next click.
 */
function PreviewHint({
  preview,
  pathname,
  language,
  onClose,
  onClosed
}: PreviewHintProps): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { form, announcementId } = preview
  const text = textIn(form.texts, language)
  const path = form.path.trim()
  const shownHere = announcementPathMatches(path ? path : null, pathname)

  const end = (): void => {
    endAnnouncementPreview()
    onClose()
  }

  const backToEditor = (): void => {
    onClose()
    void (announcementId
      ? navigate({
          to: '/admin/announcements/$announcementId',
          params: { announcementId }
        })
      : navigate({ to: '/admin/announcements/new' }))
  }

  return (
    <AnnouncementDialog
      open
      onClose={onClose}
      onCloseAutoFocus={onClosed}
      meta={
        <Badge tone="info" appearance="filled">
          {t('announcements.preview.badge')}
        </Badge>
      }
      title={text.title.trim() || t('announcements.preview.untitled')}
      body={text.body}
      frameProps={hintMarker}
      footer={
        <>
          <Button variant="secondary" onClick={end}>
            {t('announcements.preview.end')}
          </Button>
          <Button onClick={backToEditor}>{t('announcements.preview.back')}</Button>
        </>
      }
    >
      {shownHere ? null : (
        <Badge tone="warning" appearance="text">
          {t('announcements.preview.otherPath')}
        </Badge>
      )}
    </AnnouncementDialog>
  )
}
