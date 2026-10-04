import { useEffect, useRef, useState } from 'react'
import { CheckIcon, CopyIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Avatar, Button } from '@ki4jlu/design-system'
import { TRANSCRIPTION_SPEAKER_COLORS, type TranscriptionSpeakerColorId } from '@justcampus/shared'
import { toast } from '@/lib/toast'
import { initialsOf } from './format'

const ICON = { 'aria-hidden': true, className: 'size-4' } as const

/** How long "Kopiert!" stays, as in kiChat's export footer. */
const COPIED_MS = 2000

/**
 * A speaker's avatar in the speaker's colour.
 * DS gap: Avatar has no categorical colours; the transcript's speaker colour is set inline.
 */
export function SpeakerAvatar({
  name,
  colorId,
  size = 'sm'
}: {
  name: string
  colorId: TranscriptionSpeakerColorId
  size?: 'xs' | 'sm'
}): React.JSX.Element {
  return (
    <Avatar
      aria-hidden="true"
      initials={initialsOf(name)}
      size={size}
      style={{ backgroundColor: TRANSCRIPTION_SPEAKER_COLORS[colorId] }}
    />
  )
}

/**
 * Copies a text and says "Kopiert!" for about two seconds (T-32); a refused clipboard is reported.
 * `text` is asked for at the click, so it is current.
 */
export function CopyAction({
  text,
  disabled
}: {
  text: () => string | Promise<string>
  disabled?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  const copy = async (): Promise<void> => {
    try {
      const value = await text()
      if (!value) return
      await navigator.clipboard.writeText(value)
      setCopied(true)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), COPIED_MS)
    } catch {
      toast({ variant: 'error', title: t('transcription.export.copyFailed') })
    }
  }

  return (
    <>
      <Button type="button" variant="outline" disabled={disabled} onClick={() => void copy()}>
        {copied ? <CheckIcon {...ICON} /> : <CopyIcon {...ICON} />}
        {copied ? t('transcription.export.copied') : t('transcription.common.copy')}
      </Button>
      <span aria-live="polite" className="sr-only">
        {copied ? t('transcription.export.copied') : ''}
      </span>
    </>
  )
}
