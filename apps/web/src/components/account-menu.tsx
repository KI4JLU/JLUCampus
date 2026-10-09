import { useRef, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { CheckIcon, LogOutIcon, SettingsIcon, ShieldIcon, SparklesIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  SidebarUserMenu
} from '@ki4jlu/design-system'
import { LANGUAGES, type Me } from '@justcampus/shared'
import { useLanguage } from '@/lib/language'
import { useOpenNews } from '@/lib/news-context'
import { signOut } from '@/lib/session'
import { toast } from '@/lib/toast'
import { TOUR } from '@/lib/tour-targets'
import { UserSettingsDialog } from './user-settings-dialog'

const ICON = { 'aria-hidden': true, width: '1em', height: '1em' } as const

/**
 * The signed-in user at the foot of the column, with settings, the news, admin, language and
 * sign-out.
 */
export function AccountMenu({ me }: { me: Me }): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { language, setLanguage } = useLanguage({ persist: true })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const openNews = useOpenNews()
  const menuRef = useRef<HTMLDivElement>(null)
  const displayName = me.name || me.email

  const handleSignOut = async (): Promise<void> => {
    const result = await signOut()
    if (!result.ok) {
      toast({ variant: 'error', title: t('account.signOutFailed') })
      return
    }
    // Keycloak's end-session page ends the SSO session too; the desktop app keeps its window.
    if (result.providerLogoutUrl && !window.justCampus) {
      window.location.assign(result.providerLogoutUrl)
      return
    }
    await navigate({ to: '/login', search: {} })
  }

  // The menu item that opened the dialog is gone by the time it closes, so focus goes back to the
  // menu's trigger, after the dialog has let go of it.
  const handleSettingsOpenChange = (open: boolean): void => {
    setSettingsOpen(open)
    if (!open) requestAnimationFrame(() => menuRef.current?.querySelector('button')?.focus())
  }

  return (
    <div ref={menuRef} className="contents" data-tour={TOUR.accountMenu}>
      <SidebarUserMenu initials={initialsOf(displayName)} name={displayName} role={me.email}>
        <DropdownMenuItem onSelect={() => setSettingsOpen(true)}>
          <SettingsIcon {...ICON} />
          {t('account.settings')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => openNews(menuRef.current?.querySelector('button') ?? null)}
        >
          <SparklesIcon {...ICON} />
          {t('account.news')}
        </DropdownMenuItem>
        {me.role === 'admin' ? (
          <DropdownMenuItem asChild>
            <Link to="/admin/components">
              <ShieldIcon {...ICON} />
              {t('account.admin')}
            </Link>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t('language.label')}</DropdownMenuLabel>
        {LANGUAGES.map((option) => (
          <DropdownMenuItem
            key={option}
            role="menuitemradio"
            aria-checked={language === option}
            selected={language === option}
            lang={option}
            onSelect={() => setLanguage(option)}
          >
            {t(`language.${option}`)}
            {language === option ? <CheckIcon {...ICON} className="ml-auto" /> : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => void handleSignOut()}>
          <LogOutIcon {...ICON} />
          {t('account.signOut')}
        </DropdownMenuItem>
      </SidebarUserMenu>
      <UserSettingsDialog me={me} open={settingsOpen} onOpenChange={handleSettingsOpenChange} />
    </div>
  )
}

/** "Anna Schmidt" → "AS", "anna.schmidt@…" → "AS", "anna" → "AN". */
function initialsOf(value: string): string {
  const parts = (value.split('@')[0] ?? '').split(/[\s._-]+/).filter(Boolean)
  const letters =
    parts.length > 1 ? parts.slice(0, 2).map((part) => part[0]) : [parts[0]?.slice(0, 2)]
  return letters.join('').toUpperCase() || '?'
}
