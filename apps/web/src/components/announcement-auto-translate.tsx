import { useEffect, useId, useRef, useState } from 'react'
import { LanguagesIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@ki4jlu/design-system'
import type { Language } from '@justcampus/shared'
import type { AnnouncementTextDraft } from '@/lib/announcement-form'
import { translateAnnouncementText } from '@/lib/announcement-translation'
import { translateText, useTranslatorEngines } from '@/lib/queries'
import { toast } from '@/lib/toast'

const ICON = { 'aria-hidden': true, width: '1em', height: '1em' } as const

interface AnnouncementAutoTranslateProps {
  from: Language
  to: Language
  /** The text in `from`, what gets translated. */
  source: AnnouncementTextDraft
  /** The text in `to` so far; replacing one that is not empty asks first. */
  current: AnnouncementTextDraft
  onTranslated: (text: AnnouncementTextDraft) => void
}

/**
 * Fills one language's title and text with a translation of another's, by the translator
 * module's default engine. The result lands in the form, unsaved, for the admin to check. Without
 * a translator (module off, no engine) the button stays disabled and says why.
 */
export function AnnouncementAutoTranslate({
  from,
  to,
  source,
  current,
  onTranslated
}: AnnouncementAutoTranslateProps): React.JSX.Element {
  const { t } = useTranslation()
  const hintId = useId()
  const engines = useTranslatorEngines()
  const [pending, setPending] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const request = useRef<AbortController | null>(null)

  useEffect(() => () => request.current?.abort(), [])

  const available = engines.isSuccess && engines.data.engines.length > 0
  const hasSource = Boolean(source.title.trim() && source.body.trim())
  const fromName = t(`admin.announcements.translate.from.${from}`)

  const run = async (): Promise<void> => {
    setConfirming(false)
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setPending(true)
    try {
      const text = await translateAnnouncementText(source, from, to, (body) =>
        translateText(body, controller.signal)
      )
      if (controller.signal.aborted) return
      onTranslated(text)
      toast({ variant: 'success', title: t('admin.announcements.translate.done') })
    } catch {
      if (!controller.signal.aborted) {
        toast({ variant: 'error', title: t('admin.announcements.translate.failed') })
      }
    } finally {
      if (request.current === controller) {
        request.current = null
        setPending(false)
      }
    }
  }

  const start = (): void => {
    if (current.title.trim() || current.body.trim()) setConfirming(true)
    else void run()
  }

  return (
    <div className="flex flex-wrap items-center gap-stack-sm">
      <Button
        type="button"
        variant="secondary"
        disabled={!available || !hasSource || pending}
        aria-describedby={hintId}
        onClick={start}
      >
        <LanguagesIcon {...ICON} />
        {pending
          ? t('admin.announcements.translate.pending')
          : t('admin.announcements.translate.button', { from: fromName })}
      </Button>
      <p id={hintId} className="m-0 text-sm text-on-surface-variant">
        {engines.isPending
          ? t('common.loading')
          : !available
            ? t('admin.announcements.translate.unavailable')
            : !hasSource
              ? t('admin.announcements.translate.needsSource', { from: fromName })
              : t('admin.announcements.translate.hint')}
      </p>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent closeLabel={t('common.close')}>
          <DialogHeader>
            <DialogTitle>{t('admin.announcements.translate.replaceTitle')}</DialogTitle>
            <DialogDescription>
              {t('admin.announcements.translate.replaceDescription', { from: fromName })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="secondary">{t('common.cancel')}</Button>
            </DialogClose>
            <Button onClick={() => void run()}>{t('admin.announcements.translate.replace')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
