import type { ReactNode } from 'react'
import type { TFunction } from 'i18next'
import { FolderPlusIcon, LinkIcon, RssIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@ki4jlu/design-system'
import { widgetRefKey, type FolderTemplate } from '@justcampus/shared'
import { externalUrlOf, widgetViewOf } from '@/adapters/registry'
import { useComponentName } from '@/lib/component-name'
import type { ComponentWidget } from '@/lib/widgets'
import { ComponentIcon } from './component-icon'
import { FolderTitleIcon } from './folder-title-icon'

interface AddWidgetDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Every widget of every enabled component, in catalogue order. */
  widgets: ComponentWidget[]
  /** Enabled folder templates, in the admin's order. */
  templates: FolderTemplate[]
  onAdd: (widget: ComponentWidget) => void
  onAddFolder: () => void
  onAddTemplate: (template: FolderTemplate) => void
  onAddShortcut: () => void
  onAddFeed: () => void
}

const ICON = { 'aria-hidden': true, width: '1em', height: '1em' } as const

/**
 * The user's own tiles (folder, shortcut, feed) first, then the folders JLU
 * predefines, then the widgets of JLU's components, each named after its
 * component.
 */
export function AddWidgetDialog({
  open,
  onOpenChange,
  widgets,
  templates,
  onAdd,
  onAddFolder,
  onAddTemplate,
  onAddShortcut,
  onAddFeed
}: AddWidgetDialogProps): React.JSX.Element {
  const { t } = useTranslation()
  const componentName = useComponentName()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t('common.close')} className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('dashboard.addTitle')}</DialogTitle>
          <DialogDescription>{t('dashboard.addDescription')}</DialogDescription>
        </DialogHeader>
        <AddSection id="add-own" title={t('dashboard.addOwn')}>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            <AddButton icon={<FolderPlusIcon {...ICON} />} onClick={onAddFolder}>
              {t('dashboard.folder.new')}
            </AddButton>
            <AddButton icon={<LinkIcon {...ICON} />} onClick={onAddShortcut}>
              {t('shortcut.new')}
            </AddButton>
            <AddButton icon={<RssIcon {...ICON} />} onClick={onAddFeed}>
              {t('feed.new')}
            </AddButton>
          </ul>
        </AddSection>
        {templates.length > 0 ? (
          <AddSection id="add-templates" title={t('dashboard.addTemplates')}>
            <ul className="m-0 flex max-h-60 list-none flex-col gap-1 overflow-y-auto p-0">
              {templates.map((template) => (
                <AddButton
                  key={template.id}
                  icon={<FolderTitleIcon icon={template.icon} />}
                  onClick={() => onAddTemplate(template)}
                >
                  {template.name}
                </AddButton>
              ))}
            </ul>
          </AddSection>
        ) : null}
        <AddSection id="add-catalogue" title={t('dashboard.addCatalogue')}>
          {widgets.length === 0 ? (
            <p className="m-0 text-sm text-on-surface-variant">
              {t('dashboard.noWidgetsAvailable')}
            </p>
          ) : (
            <ul className="m-0 flex max-h-80 list-none flex-col gap-1 overflow-y-auto p-0">
              {widgets.map((widget) => (
                <AddButton
                  key={widgetRefKey(widget)}
                  icon={
                    <ComponentIcon
                      icon={widget.component.icon}
                      iconUrl={widget.component.iconUrl}
                      siteUrl={externalUrlOf(widget.component)}
                    />
                  }
                  onClick={() => onAdd(widget)}
                >
                  {widgetName(widget, componentName(widget.component), t)}
                </AddButton>
              ))}
            </ul>
          )}
        </AddSection>
      </DialogContent>
    </Dialog>
  )
}

function AddSection({
  id,
  title,
  children
}: {
  id: string
  title: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h3 id={id} className="m-0 text-sm font-medium text-on-surface-variant">
        {title}
      </h3>
      {children}
    </section>
  )
}

function AddButton({
  icon,
  onClick,
  children
}: {
  icon: ReactNode
  onClick: () => void
  children: ReactNode
}): React.JSX.Element {
  return (
    <li>
      <Button variant="ghost" className="w-full justify-start" onClick={onClick}>
        {icon}
        <span className="min-w-0 flex-1 text-left">{children}</span>
      </Button>
    </li>
  )
}

/** The component's name, with the widget's own where its type offers several. */
function widgetName(widget: ComponentWidget, componentName: string, t: TFunction): string {
  const name = widgetViewOf(widget.component, widget.widgetKey)?.name?.(t)
  return name ? `${componentName}: ${name}` : componentName
}
