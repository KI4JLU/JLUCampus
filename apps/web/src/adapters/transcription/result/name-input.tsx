import { useEffect, useRef } from 'react'
import { CheckIcon, XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button, Input } from '@ki4jlu/design-system'

interface NameInputProps {
  /** Accessible name of the field. */
  label: string
  initial?: string
  placeholder?: string
  maxLength: number
  /** Called with the trimmed text; an empty one cancels instead. */
  onSubmit: (value: string) => void
  onCancel: () => void
  /** Leaving the field submits instead of cancelling. */
  submitOnBlur?: boolean
  /** A cancel button (X) next to the check, as kiChat's history rename has. */
  cancelButton?: boolean
}

/**
 * kiChat's inline name field (speaker rename, new speaker, history rename): Enter or the check
 * button confirms, Escape or the X button (where shown) cancels, an empty name keeps the old one.
 * It takes the focus and selects its text when it appears.
 */
export function NameInput({
  label,
  initial = '',
  placeholder,
  maxLength,
  onSubmit,
  onCancel,
  submitOnBlur = false,
  cancelButton = false
}: NameInputProps): React.JSX.Element {
  const { t } = useTranslation()
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)

  // After the frame, so a closing menu cannot take the focus back to its trigger.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      ref.current?.focus()
      ref.current?.select()
    })
    return () => cancelAnimationFrame(frame)
  }, [])

  const finish = (submit: boolean): void => {
    if (done.current) return
    done.current = true
    const value = ref.current?.value.trim() ?? ''
    if (submit && value) onSubmit(value)
    else onCancel()
  }

  return (
    <span className="flex min-w-0 flex-1 items-center gap-1">
      <Input
        ref={ref}
        defaultValue={initial}
        aria-label={label}
        placeholder={placeholder}
        maxLength={maxLength}
        className="min-w-0 flex-1"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Enter') {
            event.preventDefault()
            finish(true)
          } else if (event.key === 'Escape') {
            event.preventDefault()
            finish(false)
          }
        }}
        onBlur={() => finish(submitOnBlur)}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={t('transcription.common.confirm')}
        // Keeps the focus in the field, so its blur does not cancel first.
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => {
          event.stopPropagation()
          finish(true)
        }}
      >
        <CheckIcon aria-hidden="true" className="size-4" />
      </Button>
      {cancelButton ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t('transcription.common.cancel')}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.stopPropagation()
            finish(false)
          }}
        >
          <XIcon aria-hidden="true" className="size-4" />
        </Button>
      ) : null}
    </span>
  )
}
