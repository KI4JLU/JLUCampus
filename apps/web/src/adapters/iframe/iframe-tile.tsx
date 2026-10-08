import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { ComponentIcon } from '@/components/component-icon'
import { useComponentName } from '@/lib/component-name'
import type { ComponentViewProps } from '../types'

/**
 * On the dashboard an embedded site is one button: the whole tile body opens
 * the component's page, where the site is shown in full. Nothing is loaded from
 * the site until then, and a 2 × 2 tile is still a comfortable target.
 */
export function IframeTile({ component }: ComponentViewProps<'iframe'>): React.JSX.Element {
  const { t } = useTranslation()
  const name = useComponentName()(component)

  return (
    <Link
      to="/c/$componentId"
      params={{ componentId: component.id }}
      aria-label={t('dashboard.openPage', { name })}
      className="flex size-full flex-col items-center justify-center gap-2 p-3 text-center text-on-surface no-underline transition-colors hover:bg-surface-container focus-visible:bg-surface-container"
    >
      <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-primary-container text-xl text-on-primary-container">
        <ComponentIcon icon={component.icon} iconUrl={component.iconUrl} />
      </span>
      <span className="line-clamp-2 max-w-full font-semibold">{name}</span>
    </Link>
  )
}
