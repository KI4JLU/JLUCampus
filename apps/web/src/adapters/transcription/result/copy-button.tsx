import { useEffect, useRef, useState } from 'react'
import { CheckIcon, CopyIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button, Tooltip, TooltipContent, TooltipTrigger } from '@ki4jlu/design-system'
import { toast } from '@/lib/toast'

/** How long a copy button says "Kopiert!", as kiChat's (T-32). */
const COPIED_MS = 2000

/**
 * Copies a speaker block (T-32): its tooltip says "Abschnitt kopieren", for two seconds after a
 * copy "Kopiert!" with a check, which screen readers hear too. A refused copy is reported.
 */
export function CopyBlockButton({ text }: { text: () => string }): React.JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const [hovered, setHovered] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
  const label = t('transcription.result.copySection')

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text())
    } catch {
      toast({ variant: 'error', title: t('transcription.result.copyFailed') })
      return
    }
    setCopied(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), COPIED_MS)
  }

  return (
    <>
      <Tooltip open={copied || hovered} onOpenChange={setHovered}>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={label}
            onClick={() => void copy()}
          >
            {copied ? (
              <CheckIcon aria-hidden="true" className="size-4" />
            ) : (
              <CopyIcon aria-hidden="true" className="size-4" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{copied ? t('transcription.result.copied') : label}</TooltipContent>
      </Tooltip>
      <span aria-live="polite" className="sr-only">
        {copied ? t('transcription.result.copied') : ''}
      </span>
    </>
  )
}
