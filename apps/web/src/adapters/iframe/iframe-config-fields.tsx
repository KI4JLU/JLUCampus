import { useTranslation } from 'react-i18next'
import { Input } from '@ki4jlu/design-system'
import { Field } from '@/components/field'
import { FormSection } from '@/components/form-section'
import type { ComponentConfigFieldsProps } from '../types'

export function IframeConfigFields({
  config,
  onChange,
  errors,
  idPrefix
}: ComponentConfigFieldsProps<'iframe'>): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <FormSection title={t('admin.form.configuration')}>
      <Field
        id={`${idPrefix}-url`}
        label={t('component.iframe.urlLabel')}
        hint={t('component.iframe.urlHint')}
        error={errors.url}
      >
        {(control) => (
          <Input
            {...control}
            type="url"
            inputMode="url"
            autoComplete="url"
            placeholder="https://"
            value={config.url}
            onChange={(event) => onChange({ ...config, url: event.target.value })}
            required
          />
        )}
      </Field>
    </FormSection>
  )
}
