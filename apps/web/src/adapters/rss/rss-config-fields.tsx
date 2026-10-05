import { useTranslation } from 'react-i18next'
import { Input } from '@ki4jlu/design-system'
import { FeedCheck } from '@/components/feed-check'
import { Field } from '@/components/field'
import { FormSection } from '@/components/form-section'
import type { ComponentConfigFieldsProps } from '../types'

export function RssConfigFields({
  config,
  onChange,
  errors,
  idPrefix
}: ComponentConfigFieldsProps<'rss'>): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <FormSection title={t('admin.form.configuration')}>
      <div className="grid gap-2">
        <Field
          id={`${idPrefix}-feed-url`}
          label={t('component.rss.feedUrlLabel')}
          hint={t('component.rss.feedUrlHint')}
          error={errors.feedUrl}
        >
          {(control) => (
            <Input
              {...control}
              type="url"
              inputMode="url"
              autoComplete="url"
              placeholder="https://"
              value={config.feedUrl}
              onChange={(event) => onChange({ ...config, feedUrl: event.target.value })}
              required
            />
          )}
        </Field>
        <FeedCheck url={config.feedUrl} />
      </div>
    </FormSection>
  )
}
