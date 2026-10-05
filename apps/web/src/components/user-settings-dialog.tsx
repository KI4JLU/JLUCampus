import { useId } from 'react'
import { MonitorIcon, SettingsIcon, UserIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SettingsDialog,
  SettingsRow,
  ThemeToggle,
  type SettingsSection
} from '@ki4jlu/design-system'
import { LANGUAGES, languageSchema, type Me } from '@justcampus/shared'
import { DesktopSettings } from '@/desktop/desktop-settings'
import { desktopModuleSettings } from '@/desktop/registry'
import { useLanguage } from '@/lib/language'

const ICON = { 'aria-hidden': true, width: '1em', height: '1em' } as const
/** Shown for a profile field Keycloak did not send. */
const EMPTY = '–'

interface UserSettingsDialogProps {
  me: Me
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * The user's settings window: general settings (colour scheme, interface language saved to the
 * profile), the read-only profile from Keycloak, and in the desktop app the settings of its modules.
 */
export function UserSettingsDialog({
  me,
  open,
  onOpenChange
}: UserSettingsDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const { language, setLanguage } = useLanguage({ persist: true })
  const languageLabelId = useId()
  const themeLabelId = useId()
  const desktopModules = desktopModuleSettings()
  const desktopSection: SettingsSection[] =
    desktopModules.length === 0
      ? []
      : [
          {
            value: 'desktop',
            label: t('desktop.settings.title'),
            icon: <MonitorIcon {...ICON} />,
            keywords: desktopModules.map(({ view }) => t(`desktop.${view.id}.name`)),
            content: <DesktopSettings modules={desktopModules} />
          }
        ]

  return (
    <SettingsDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('settings.title')}
      closeLabel={t('common.close')}
      searchPlaceholder={t('settings.search')}
      emptyLabel={t('settings.noMatches')}
      sections={[
        {
          value: 'general',
          label: t('settings.general.title'),
          icon: <SettingsIcon {...ICON} />,
          keywords: [
            t('theme.label'),
            t('theme.light'),
            t('theme.dark'),
            t('settings.language.label')
          ],
          content: (
            <>
              <SettingsRow
                label={t('theme.label')}
                description={t('settings.appearance.description')}
                labelId={themeLabelId}
                control={
                  <ThemeToggle
                    themeLabel={t('theme.label')}
                    lightLabel={t('theme.light')}
                    systemLabel={t('theme.system')}
                    darkLabel={t('theme.dark')}
                  />
                }
              />
              <SettingsRow
                label={t('settings.language.label')}
                description={t('settings.language.description')}
                labelId={languageLabelId}
                control={
                  <Select
                    value={language}
                    onValueChange={(value) => {
                      const parsed = languageSchema.safeParse(value)
                      if (parsed.success) setLanguage(parsed.data)
                    }}
                  >
                    <SelectTrigger aria-labelledby={languageLabelId} className="w-44">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LANGUAGES.map((option) => (
                        <SelectItem key={option} value={option} lang={option}>
                          {t(`language.${option}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                }
              />
            </>
          )
        },
        {
          value: 'profile',
          label: t('settings.profile.title'),
          icon: <UserIcon {...ICON} />,
          keywords: [
            t('settings.profile.username'),
            t('settings.profile.givenName'),
            t('settings.profile.familyName'),
            t('settings.profile.email'),
            t('settings.profile.role')
          ],
          content: (
            <>
              <SettingsRow
                label={t('settings.profile.username')}
                control={me.username ? `@${me.username}` : EMPTY}
              />
              <SettingsRow
                label={t('settings.profile.givenName')}
                control={me.givenName ?? EMPTY}
              />
              <SettingsRow
                label={t('settings.profile.familyName')}
                control={me.familyName ?? EMPTY}
              />
              <SettingsRow label={t('settings.profile.email')} control={me.email || EMPTY} />
              <SettingsRow
                label={t('settings.profile.role')}
                description={t('settings.profile.managed')}
                control={t(`settings.profile.roles.${me.role}`)}
              />
            </>
          )
        },
        ...desktopSection
      ]}
    />
  )
}
