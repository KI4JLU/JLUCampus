import { useCallback, useEffect, useEffectEvent, useState, type ReactNode } from 'react'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Badge, Button } from '@ki4jlu/design-system'
import { announcementPathMatches, type Language } from '@justcampus/shared'
import { currentLanguage } from '@/i18n'
import {
  allNews,
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
import { hintMarker, useModalLayerOpen } from '@/lib/hint-layer'
import { OpenNewsContext } from '@/lib/news-context'
import { announcementsQuery, meQuery, useMarkAnnouncementSeen } from '@/lib/queries'
import { toast } from '@/lib/toast'
import { useVisibleTarget } from '@/lib/use-visible-target'
import { AnnouncementDialog } from './announcement-dialog'
import { NewsDialog } from './news-dialog'

/** How long a preview looks for its element on a page before it says it found none. */
const PREVIEW_NOT_FOUND_MS = 4000

function sameHint(a: OpenedHint | null, b: OpenedHint): boolean {
  if (a?.kind !== b.kind) return false
  return a.kind === 'preview' || (b.kind === 'hint' && a.id === b.id)
}

/** Keys that open a pop-up trigger's menu or list. */
const OPENING_KEYS = new Set(['Enter', ' ', 'ArrowDown'])

/** Whether `target` is (in) a control that opens a menu, list or dialog. */
function isPopupTrigger(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('[aria-haspopup]:not([aria-haspopup="false"])') !== null
  )
}

/**
 * The hint a click opened. `shown` once its dialog is open; until then it waits for a modal layer
 * the click opened (or one already open) to close.
 */
type OpenedHint = { kind: 'hint'; id: string; shown: boolean } | { kind: 'preview'; shown: boolean }

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
 * started, and an unread hint, as a dialog of its own, when the user clicks its element.
 * Listeners on the document (capture phase, so they see every click first, and leave it alone)
 * find the hint: the oldest unread one for the page whose element is the clicked one or contains
 * it. The element's own action runs as usual; when that opens a modal layer (a dialog, a menu),
 * the hint waits until it closes. Non-modal panels ("More apps") stay open under it. One hint at
 * a time: clicks open nothing while a hint or the news are open. While an admin tries a hint out
 * from its editor, that preview takes the hints' place, for that admin only. `children` (the app
 * frame) can reopen the news from `OpenNewsContext`.
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
  const modalOpen = useModalLayerOpen()
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

  // Waiting is decided only until the hint's dialog opens: its own dialog is a modal layer too.
  if (opened && active && !opened.shown && !modalOpen) setOpened({ ...opened, shown: true })

  const activate = useEffectEvent((target: EventTarget | null) => {
    if (newsOpen || active || !(target instanceof Element)) return
    const closest = (selector: string): Element | null => target.closest(selector)
    let next: OpenedHint | null = null
    if (previewing) {
      const hit = closestMatch(preview.form.selector.trim(), closest)
      if (hit) next = { kind: 'preview', shown: false }
    } else {
      const match = announcements ? hintForClick(announcements, pathname, closest) : null
      if (match) next = { kind: 'hint', id: match.hint.id, shown: false }
    }
    if (!next) return
    const opening = next
    // After the element's own handlers and the effects they cause: a dialog or menu it opens has
    // made the page modal by then, and the hint waits for it. A press and the click it ends may
    // both ask; the second finds it opened already.
    window.setTimeout(() =>
      setOpened((current) => (sameHint(current, opening) ? current : opening))
    )
  })

  // Clicks (also Enter and Space on buttons) open hints. Radix opens menus and lists on the press
  // or key instead, and its modal ones then keep the click from reaching their trigger, so on
  // pop-up triggers the press and the opening keys count too; whichever comes first opens it.
  useEffect(() => {
    const onClick = (event: MouseEvent): void => activate(event.target)
    const onPointerDown = (event: PointerEvent): void => {
      if (event.button === 0 && isPopupTrigger(event.target)) activate(event.target)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (OPENING_KEYS.has(event.key) && isPopupTrigger(event.target)) activate(event.target)
    }
    document.addEventListener('click', onClick, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [])

  const close = (): void => setOpened(null)

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
      {previewing ? <PreviewNotices pathname={pathname} selector={preview.form.selector} /> : null}
      {opened?.shown && openPreview ? (
        <PreviewHint
          preview={openPreview}
          pathname={pathname}
          language={language}
          onClose={close}
        />
      ) : null}
      {opened?.shown && openHint ? (
        <PageHint
          key={openHint.id}
          hint={openHint}
          language={language}
          onSeen={() => {
            acknowledge(openHint.id)
            close()
          }}
        />
      ) : null}
    </OpenNewsContext.Provider>
  )
}

interface PageHintProps {
  hint: UserHint
  language: Language
  onSeen: () => void
}

/**
 * An unread hint a click opened. Closing it in any way marks it seen; the focus goes back to what
 * had it, the clicked element as a rule.
 */
function PageHint({ hint, language, onSeen }: PageHintProps): React.JSX.Element {
  const { t } = useTranslation()
  const text = textIn(hint.texts, language)
  return (
    <AnnouncementDialog
      open
      onClose={onSeen}
      meta={t('announcements.hint.label')}
      title={text.title}
      body={text.body}
      frameProps={hintMarker}
      footer={<Button onClick={onSeen}>{t('announcements.hint.gotIt')}</Button>}
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
}

/**
 * The hint an admin tries out, unsaved, opened by a click on its element on whichever page they
 * are, whether or not its page path would offer it there (it says when not). It marks nothing
 * seen; closing it keeps the preview on for the next click.
 */
function PreviewHint({
  preview,
  pathname,
  language,
  onClose
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
