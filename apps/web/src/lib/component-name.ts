import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  componentName,
  DEFAULT_LANGUAGE,
  languageSchema,
  type ComponentNameTranslations
} from '@justcampus/shared'

type NamedComponent = { name: string; nameTranslations: ComponentNameTranslations }

/**
 * A function that returns a component's name in the UI language: its translation for that language,
 * else its main name. Re-renders the caller when the language changes; the function stays the same
 * until then, so it can be a memo's dependency.
 */
export function useComponentName(): (component: NamedComponent) => string {
  const { i18n } = useTranslation()
  const parsed = languageSchema.safeParse(i18n.resolvedLanguage)
  const language = parsed.success ? parsed.data : DEFAULT_LANGUAGE
  return useCallback((component) => componentName(component, language), [language])
}
