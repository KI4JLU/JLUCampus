import { useTranslation } from 'react-i18next'
import { FormSection } from '@/components/form-section'

/** A desktop component has nothing to configure here: each device sets it up in the app. */
export function FilesConfigFields(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <FormSection
      title={t('admin.form.configuration')}
      description={t('component.files.configNote')}
    />
  )
}
