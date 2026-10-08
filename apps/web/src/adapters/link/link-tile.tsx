import { ComponentIcon } from '@/components/component-icon'
import { ShortcutLink } from '@/components/shortcut-link'
import { useComponentName } from '@/lib/component-name'
import type { ComponentViewProps } from '../types'

/** A catalogue shortcut: the whole tile opens its URL outside the app. */
export function LinkTile({ component }: ComponentViewProps<'link'>): React.JSX.Element {
  const { url } = component.config
  const componentName = useComponentName()
  return (
    <ShortcutLink
      url={url}
      title={componentName(component)}
      icon={<ComponentIcon icon={component.icon} iconUrl={component.iconUrl} siteUrl={url} />}
    />
  )
}
