import { useState } from 'react'
import { XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge, Button, Input } from '@ki4jlu/design-system'
import { addNames, remainingSuggestions } from '@/lib/roles'
import { Field } from './field'

const ICON = { 'aria-hidden': true, width: '1em', height: '1em' } as const

interface KeycloakNamesFieldProps {
  id: string
  label: string
  hint: string
  error?: string
  names: readonly string[]
  /** Names seen at users' sign-ins, offered while typing; those in the list already are not. */
  suggestions: readonly string[] | undefined
  onChange: (names: string[]) => void
}

/**
 * A list of Keycloak role or group names, typed freely: Enter, the add button or leaving the
 * field adds what was typed (several at once, split at commas). The names below can be removed
 * one by one.
 */
export function KeycloakNamesField({
  id,
  label,
  hint,
  error,
  names,
  suggestions,
  onChange
}: KeycloakNamesFieldProps): React.JSX.Element {
  const { t } = useTranslation()
  const [draft, setDraft] = useState('')
  const offered = remainingSuggestions(suggestions, names)
  const listId = `${id}-suggestions`

  const add = (): void => {
    if (!draft.trim()) return
    onChange(addNames(names, draft))
    setDraft('')
  }

  return (
    <div className="flex flex-col gap-stack-sm">
      <Field id={id} label={label} hint={hint} error={error}>
        {(control) => (
          <div className="flex items-center gap-stack-sm">
            <Input
              {...control}
              className="min-w-0 flex-1"
              value={draft}
              autoComplete="off"
              spellCheck={false}
              list={offered.length > 0 ? listId : undefined}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={add}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return
                // Enter adds the name; it does not submit the form.
                event.preventDefault()
                add()
              }}
            />
            <Button type="button" variant="outline" disabled={!draft.trim()} onClick={add}>
              {t('admin.roles.form.add')}
            </Button>
          </div>
        )}
      </Field>
      {offered.length > 0 ? (
        <datalist id={listId}>
          {offered.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
      ) : null}
      {names.length === 0 ? (
        <p className="m-0">{t('admin.roles.form.noNames')}</p>
      ) : (
        <ul aria-label={label} className="m-0 flex list-none flex-wrap gap-2 p-0">
          {names.map((name) => (
            // DS gap: no removable chip; a badge with an icon button beside it stands in.
            <li key={name} className="flex items-center gap-1">
              <Badge>{name}</Badge>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t('admin.roles.form.remove', { name })}
                onClick={() => onChange(names.filter((other) => other !== name))}
              >
                <XIcon {...ICON} />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
